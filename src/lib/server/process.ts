import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { join } from 'path';
import fs from 'fs/promises';
import { env } from '$env/dynamic/private';
import { assert } from './util';
import { PassThrough } from 'stream';

// Configure ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface ImagePair {
	first: Buffer;
	second: Buffer;
}

interface ImageDimensions {
	width: number;
	height: number;
	aspectRatio: number;
}

enum MergeDirection {
	HORIZONTAL = 'horizontal',
	VERTICAL = 'vertical'
}

interface ProcessingOptions {
	folder: string;
	fps?: number;
	cleanup?: boolean;
}

export class ImageVideoProcessor {
	private readonly outputDir = env.OUTPUT_DIR!;
	private readonly videoOutput = 'output.mp4';
	private readonly fps: number;
	private readonly shouldCleanup: boolean;

	constructor({ folder, fps = 24, cleanup = false }: ProcessingOptions) {
		this.outputDir = join(this.outputDir, folder);

		this.fps = fps;
		this.shouldCleanup = cleanup;
	}

	private async getImageDimensions(image: Buffer): Promise<ImageDimensions> {
		const metadata = await sharp(image).metadata();

		if (!metadata.width || !metadata.height) {
			throw new ImageProcessingError('Invalid image metadata');
		}

		return {
			width: metadata.width,
			height: metadata.height,
			aspectRatio: metadata.width / metadata.height
		};
	}

	private async determineMergeDirection(
		image1Buffer: Buffer,
		image2Buffer: Buffer
	): Promise<MergeDirection> {
		const [img1Dims, img2Dims] = await Promise.all([
			this.getImageDimensions(image1Buffer),
			this.getImageDimensions(image2Buffer)
		]);

		// Calculate aspect ratios for both merge strategies
		const horizontalAspectRatio =
			(img1Dims.width + img2Dims.width) / Math.max(img1Dims.height, img2Dims.height);
		const verticalAspectRatio =
			Math.max(img1Dims.width, img2Dims.width) / (img1Dims.height + img2Dims.height);

		// Calculate how far each aspect ratio is from the "ideal" aspect ratio (16:9 = 1.778)
		const idealAspectRatio = 9 / 16;
		const horizontalDiff = Math.abs(horizontalAspectRatio - idealAspectRatio);
		const verticalDiff = Math.abs(verticalAspectRatio - idealAspectRatio);

		// Choose the direction that results in an aspect ratio closer to 16:9
		return horizontalDiff < verticalDiff ? MergeDirection.HORIZONTAL : MergeDirection.VERTICAL;
	}

	public async mergeSideBySide(image1: Buffer, image2: Buffer): Promise<Buffer> {
		try {
			const [img1Meta, img2Meta] = await Promise.all([
				sharp(image1).metadata(),
				sharp(image2).metadata()
			]);

			if (!img1Meta.width || !img2Meta.width || !img1Meta.height || !img2Meta.height) {
				throw new ImageProcessingError('Invalid image metadata');
			}

			const totalHeight = Math.max(img1Meta.height, img2Meta.height);

			const outputBuffer = await sharp({
				create: {
					width: img1Meta.width + img2Meta.width,
					height: totalHeight,
					channels: 4,
					background: { r: 255, g: 255, b: 255, alpha: 1 }
				}
			})
				.composite([
					{
						input: image1,
						left: 0,
						top: Math.floor((totalHeight - img1Meta.height) / 2)
					},
					{
						input: image2,
						left: img1Meta.width,
						top: Math.floor((totalHeight - img2Meta.height) / 2)
					}
				])
				.jpeg()
				.toBuffer();

			return outputBuffer;
		} catch (error) {
			console.error('Error merging images side by side:', error);
			throw error;
		}
	}

	private async mergeTopAndBottom(image1: Buffer, image2: Buffer): Promise<Buffer> {
		try {
			const [img1Meta, img2Meta] = await Promise.all([
				sharp(image1).metadata(),
				sharp(image2).metadata()
			]);

			if (!img1Meta.width || !img2Meta.width || !img1Meta.height || !img2Meta.height) {
				throw new ImageProcessingError('Invalid image metadata');
			}

			const totalWidth = Math.max(img1Meta.width, img2Meta.width);

			const outputBuffer = await sharp({
				create: {
					width: totalWidth,
					height: img1Meta.height + img2Meta.height,
					channels: 4,
					background: { r: 255, g: 255, b: 255, alpha: 1 }
				}
			})
				.composite([
					{
						input: image1,
						left: Math.floor((totalWidth - img1Meta.width) / 2),
						top: 0
					},
					{
						input: image2,
						left: Math.floor((totalWidth - img2Meta.width) / 2),
						top: img1Meta.height
					}
				])
				.jpeg()
				.toBuffer();

			return outputBuffer;
		} catch (error) {
			console.error('Error merging images top and bottom:', error);
			throw error;
		}
	}

	private async mergeImages(image1: Buffer, image2: Buffer): Promise<Buffer> {
		const direction = await this.determineMergeDirection(image1, image2);
		console.log(`Using ${direction} merge strategy`);

		switch (direction) {
			case MergeDirection.HORIZONTAL:
				return this.mergeSideBySide(image1, image2);
			case MergeDirection.VERTICAL:
				return this.mergeTopAndBottom(image1, image2);
			default:
				throw new ImageProcessingError(`Invalid merge direction: ${direction}`);
		}
	}

	private createVideoFromImages(inputDir: string): Promise<NodeJS.ReadableStream> {
		return new Promise((resolve, reject) => {
			const passThrough = new PassThrough();

			ffmpeg()
				.input(`${inputDir}/%d.jpg`)
				.inputFPS(this.fps)
				.format('mp4')
				.videoCodec('libx264')
				.outputOptions(['-movflags frag_keyframe+empty_moov']) // ensures streaming compatibility
				.on('start', (commandLine) => {
					console.log('Spawned FFmpeg with command:', commandLine);
				})
				.on('error', (err, stdout, stderr) => {
					console.error('FFmpeg error:', err.message);
					// Optionally you can log stdout and stderr for debugging:
					console.error('stdout:', stdout);
					console.error('stderr:', stderr);
					reject(err);
				})
				.on('end', () => {
					console.log('FFmpeg processing finished');
					// No need to resolve here because the stream end event will be handled by the client.
				})
				.pipe(passThrough, { end: true });

			// Resolve immediately with the passThrough stream since we expect
			// the ffmpeg to begin piping data into it.
			resolve(passThrough);
		});
	}

	public async processImagesAndCreateVideo(
		imagePairs: ImagePair[]
	): Promise<NodeJS.ReadableStream> {
		try {
			// Create output directory if it doesn't exist
			await fs.mkdir(this.outputDir, { recursive: true });

			const mergePromises = imagePairs.map((pair, index) =>
				this.mergeImages(pair.first, pair.second).then((buffer) => {
					const outputPath = join(this.outputDir, `${index + 1}.jpg`);
					return fs.writeFile(outputPath, buffer);
				})
			);

			await Promise.all(mergePromises);

			// Create video from merged images
			const videoPath = this.createVideoFromImages(this.outputDir);

			return videoPath;
		} catch (error) {
			console.error('Error in processing:', error);
			throw error;
		}
	}
}

// Custom error class for image processing
class ImageProcessingError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
		public readonly path?: string
	) {
		super(message);
		this.name = 'ImageProcessingError';
	}
}
