import { Event, EventEmitter, WorkspaceFolder } from 'vscode';
import { TestAdapter, TestLoadStartedEvent, TestLoadFinishedEvent, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent, TestSuiteInfo, RetireEvent } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { loadTests, runAllTests } from './tests';
import * as util from 'util';
import { durationToString } from './utils';

export class DMAdapter implements TestAdapter {
	private disposables: { dispose(): void }[] = [];

	private cancelEmitter: EventEmitter<void> = new EventEmitter<void>();

	private readonly testsEmitter = new EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
	private readonly retireEmitter = new EventEmitter<RetireEvent>();

	private isLoading = false;
	private isRunning = false;
	private isCanceling = false;
	private loadedTests: TestSuiteInfo | undefined;

	get tests(): Event<TestLoadStartedEvent | TestLoadFinishedEvent> { return this.testsEmitter.event; }
	get testStates(): Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> { return this.testStatesEmitter.event; }
	get retire(): Event<RetireEvent> { return this.retireEmitter.event; }

	constructor(
		public readonly workspace: WorkspaceFolder,
		private readonly log: Log
	) {
		this.log.info('Initializing Tgstation Test Adapter');

		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.retireEmitter);
	}

	async load(): Promise<void> {
		if (this.isLoading) {
			return;
		}

		this.isLoading = true;
		this.log.info('Loading tests...');

		this.testsEmitter.fire({ type: 'started' });

		try {
			this.loadedTests = await loadTests();
			this.testsEmitter.fire({ type: 'finished', suite: this.loadedTests });

			let numSuites = this.loadedTests.children.length;
			if(numSuites > 0){
				let numTests = this.loadedTests.children.map(suite => (suite as TestSuiteInfo).children.length).reduce((sum, len) => sum + len);
				this.log.info(`Loaded ${numTests} tests in ${numSuites} suites.`);
			} else {
				this.log.warn('No suites or tests were found in this workspace.')
			}
		} catch (e) {
			this.testsEmitter.fire({ type: 'finished', errorMessage: util.inspect(e) });
			this.log.error('Failed to load tests:\n' + util.inspect(e));
		}

		this.retireEmitter.fire({});

		this.isLoading = false;
	}

	async run(_tests: string[]): Promise<void> {
		if (this.loadedTests == undefined) {
			throw Error("Tests not loaded yet");
		}
		if (this.isRunning) {
			return;
		}

		this.isRunning = true;
		this.log.info('Starting test run...');
		const testStart = Date.now();

		let allTestSuites = this.loadedTests.children.map(suite => suite.id);
		this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests: allTestSuites });

		await runAllTests(this.loadedTests.children, this.testStatesEmitter, this.cancelEmitter, this.workspace, this.log);

		this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
		
		this.log.info(`Test run finished! Total time: ${durationToString(testStart)}`);

		// Reset any cancel listeners since theres nothing to cancel anymore
		this.cancelEmitter.dispose();
		this.cancelEmitter = new EventEmitter<void>();

		this.isRunning = false;
		this.isCanceling = false;
	}

	cancel(): void {
		if (!this.isRunning) {
			return;
		}
		if (this.isCanceling) {
			return;
		}
		this.isCanceling = true;
		this.cancelEmitter.fire();
	}

	dispose(): void {
		this.cancel();
		this.cancelEmitter.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}
}
