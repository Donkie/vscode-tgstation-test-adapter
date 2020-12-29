import { exec } from 'child_process';
import { EventEmitter, Disposable } from 'vscode';
import * as util from 'util';
import * as ps from 'ps-node';

const psLookup = util.promisify(ps.lookup);

function getRandomId() {
	return Math.floor(Math.random() * 1e10);
}

/**
 * Represents a DreamDaemon process. The daemon is started immediately in the constructor, and can be cancelled by disposing the object.
 */
class DreamDaemonProcess implements Disposable {
	private isRunning = false;
	private isDisposed = false;
	private uniqueId: number | undefined;
	private readonly cancelEmitter = new EventEmitter<void>();
	private readonly finishedEmitter = new EventEmitter<void>();

	constructor(cmd: string, args: string[]) {
		this.uniqueId = getRandomId();

		args.push('-params', `test-id=${this.uniqueId}`);

		exec(`"${cmd}" ${args.join(' ')}`, (err, _, __) => {
			// This callback is basically only called when dreamdaemon exits based on my experiments. This makes it a useful indicator of process exit.
			if(err){
				this.finishedEmitter.fire();
			}
		});
		this.isRunning = true;
	}

	async waitForFinish() {
		return new Promise<void>((resolve, _) => {
			if(!this.isRunning){
				// Has already finished
				resolve();
				return;
			}
			
			this.finishedEmitter.event(() => {
				resolve();

				// Consider it finished.
				this.isRunning = false;
			});
		})
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
		this.finishedEmitter.dispose();
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
