import { promises as fsp } from 'fs';
import * as path from 'path';
import * as child from 'child_process';
import { EventEmitter } from 'vscode';
import { CancelError } from './error';

/**
 * Checks if a file or directory exists on the local disk.
 * @param fileordir Path
 */
export async function exists(fileordir: string) {
	try {
		await fsp.access(fileordir);
		return true;
	} catch (err) {
		return false;
	}
}

/**
 * Creates a directory if it doesn't already exist.
 * @param directory Path
 */
export async function mkDir(directory: string) {
	if (!await exists(directory)) {
		await fsp.mkdir(directory);
	}
}

/**
 * Removes a directory and all files inside, if it exists. Does not handle subdirectories.
 * @param directory Path
 */
export async function rmDir(directory: string) {
	if (!await exists(directory)) {
		return;
	}
	let files = await fsp.readdir(directory);
	await Promise.all(
		files.map(file => fsp.unlink(path.join(directory, file)))
	);
	try {
		await fsp.unlink(directory);
	} catch { }
}

/**
 * Removes a file if it exists.
 * @param file Path
 */
export async function rmFile(file: string) {
	if (await exists(file)) {
		await fsp.unlink(file);
	}
}

/**
 * Spawns a cancelable child process.
 * @param command The process command.
 * @param args The process arguments.
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the process.
 */
export async function runProcess(command: string, args: string[], cancelEmitter: EventEmitter<void>) {
	return new Promise<string>((resolve, reject) => {
		let stdout = '';
		let process = child.spawn(command, args);
		let cancelListener = cancelEmitter.event(_ => {
			process.kill();
			reject(new CancelError());
		});
		process.stdout.on('data', (data: Buffer) => {
			stdout += data;
		})
		process.stderr.on('data', (data: Buffer) => {
			stdout += data;
		})
		process.once('exit', _ => {
			cancelListener.dispose();
			resolve(stdout);
		})
	});
}

/**
 * Removes the file extension of a file or filepath
 * @param file Path
 */
export function removeExtension(file: string) {
	let parts = file.split('.');
	parts.pop();
	return parts.join('.');
}

/**
 * Returns the file or directory of a path
 * @param filePath Path
 */
export function getFileFromPath(filePath: string) {
	let parts = filePath.split('/');
	return parts[parts.length - 1];
}

/**
 * Trims "text" off the start of "subject" if it starts with it, otherwise returns an unchanged "subject".
 * @param subject The string to trim from
 * @param text The text to match and trim away
 */
export function trimStart(subject: string, text: string) {
	if (subject.startsWith(text)) {
		return subject.substring(text.length);
	}
	return subject;
}

export function durationToString(dateStart: number) {
	const testDur = Math.round((Date.now() - dateStart) / 1000);
	const minutes = Math.floor(testDur/60);
	const seconds = (testDur%60).toString().padStart(2, '0');
	return `${minutes}:${seconds}`;
}