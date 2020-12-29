import { exec } from 'child_process';
import { EventEmitter, Disposable } from 'vscode';
import { getRoot } from './tests';
import * as util from 'util';
import * as ps from 'ps-node';
import { readFileContents, watchUntil } from './utils';

const psLookup = util.promisify(ps.lookup);

function getRandomId() {
	return Math.floor(Math.random() * 1e10);
}

async function waitForFileInDirChange(dir: string, filename: string, cancelEmitter: EventEmitter<void>) {
	await watchUntil(dir, cancelEmitter, async (_, fname) => {
		return fname === filename;
	});
}

async function waitForFileChange(filepath: string, cancelEmitter: EventEmitter<void>, checkdone: (contents: string) => boolean) {
	await watchUntil(filepath, cancelEmitter, async (_, __) => {
		const contents = await readFileContents(filepath);
		return checkdone(contents);
	});
}

/**
 * Represents a DreamDaemon process. The daemon is started immediately in the constructor, and can be cancelled by disposing the object.
 */
class DreamDaemonProcess implements Disposable {
	private isRunning = false;
	private isDisposed = false;
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
		if (this.isDisposed) {
			return;
		}
		this.isDisposed = true;

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
					ps.kill(programs[0].pid);
				})
				.catch(err => {
					console.error(err);
				});
		}

		this.cancelEmitter.dispose();
	}
}

/**
 * Starts a cancelable dream daemon process.
 * @param command The command to start with.
 * @param args The arguments to start with.
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the process.
 */
export async function runDreamDaemonProcess(command: string, args: string[], cancelEmitter: EventEmitter<void>) {
	let daemon = new DreamDaemonProcess(command, args);
	cancelEmitter.event(_ => {
		// Disposing the daemon object will cause the waitForFinish method to throw a CancelError, thus this lets us exit early.
		daemon.dispose();
	})
	try {
		await daemon.waitForFinish();
	}
	catch (err) {
		daemon.dispose();
		throw err;
	}
}
