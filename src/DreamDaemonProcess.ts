import { exec } from 'child_process';
import { EventEmitter, Disposable } from 'vscode';
import { getRoot } from './tests';
import * as util from 'util';
import * as ps from 'ps-node';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

const psLookup = util.promisify(ps.lookup);
const psKill = util.promisify(ps.kill);

function getRandomId() {
	return Math.floor(Math.random() * 1e10);
}

async function waitForFileInDirChange(dir: string, filename: string, cancelEmitter: EventEmitter<void>){
	return new Promise<void>((resolve, reject) => {
		let dirwatcher = fs.watch(dir);
		let cancelEmitterHandle = cancelEmitter.event(_ => {
			dirwatcher.close();
			reject(new Error("Canceled"));
		});
		dirwatcher.on('error', err => {
			cancelEmitterHandle.dispose();
			reject(err);
		})
		dirwatcher.on('change', (_, fname) => {
			if (fname === filename) {
				dirwatcher.close();
				cancelEmitterHandle.dispose();
				resolve();
			}
		});
	});
}

async function readFileContents(filepath: string){
	let handle = await fsp.open(filepath, 'r');
	let contents: string;
	try{
		let buf = await handle.readFile();
		contents = buf.toString();
	} catch(err){
		handle.close();
		throw err;
	}
	handle.close();
	return contents;
}

async function waitForFileChange(filepath: string, cancelEmitter: EventEmitter<void>, checkdone: (contents: string) => boolean){
	return new Promise<void>((resolve, reject) => {
		let filewatcher = fs.watch(filepath);
		let cancelEmitterHandle = cancelEmitter.event(_ => {
			filewatcher.close();
			reject(new Error("Canceled"));
		});
		filewatcher.on('error', err => {
			cancelEmitterHandle.dispose();
			reject(err);
		})
		filewatcher.on('change', (_, __) => {
			readFileContents(filepath)
				.then(contents => {
					if(checkdone(contents)){
						cancelEmitterHandle.dispose();
						filewatcher.close();
						resolve();
					}
				})
				.catch(err => {
					cancelEmitterHandle.dispose();
					filewatcher.close();
					reject(err);
				})
		})
	});
}

/**
 * Represents a DreamDaemon process. The daemon is started immediately in the constructor, and can be cancelled by disposing the object.
 */
export class DreamDaemonProcess implements Disposable {
	private isRunning = false;
	private uniqueId: number | undefined;
	private readonly cancelEmitter = new EventEmitter<void>();

	constructor(cmd: string, args: string[]) {
		this.uniqueId = getRandomId();

		args.push('-params', `test-id=${this.uniqueId}`);

		exec(`"${cmd}" ${args.join(' ')}`);
		this.isRunning = true;
	}


	async waitForFinish() {
		let root = getRoot();

		// Since the server is being run as a daemon, we don't get direct access to its output and we don't really know when its finished.
		// A workaround is to monitor game.log for the "server reboot" message.
		await waitForFileInDirChange(`${root.fsPath}/data/logs/unit_test`, 'game.log', this.cancelEmitter);
		await waitForFileChange(`${root.fsPath}/data/logs/unit_test/game.log`, this.cancelEmitter, contents => {
			return /Rebooting World\. Round ended\./.exec(contents) !== null;
		});

		// Consider it finished. The process might not have fully closed yet at this point but we don't really care, it's about to.
		this.isRunning = false;
	}

	dispose() {
		if (this.isRunning) {
			this.cancelEmitter.fire();

			psLookup({ command: 'dreamdaemon.exe', arguments: `test-id=${this.uniqueId}` })
				.then(programs => {
					if (programs.length == 0) {
						return;
					}
					if (programs.length > 1) {
						throw new Error("Multiple dream daemon processes with same unique id detected.");
					}
					psKill(programs[0].pid).catch(_ => { });
				})
				.catch(err => {
					console.error(err);
				});
		}

		this.cancelEmitter.dispose();
	}
}
