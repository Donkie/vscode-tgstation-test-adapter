import * as vscode from 'vscode';
import { TestAdapter, TestLoadStartedEvent, TestLoadFinishedEvent, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent, TestSuiteInfo, RetireEvent } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { loadTests, runAllTests } from './tests';
import * as util from 'util';

export class DMAdapter implements TestAdapter {
	private disposables: { dispose(): void }[] = [];

	private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
	private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();
	private readonly cancelEmitter = new vscode.EventEmitter<void>();

	private isLoading = false;
	private isRunning = false;
	private loadedTests: TestSuiteInfo | undefined;

	get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> { return this.testsEmitter.event; }
	get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> { return this.testStatesEmitter.event; }
	get retire(): vscode.Event<RetireEvent> { return this.retireEmitter.event; }

	constructor(
		public readonly workspace: vscode.WorkspaceFolder,
		private readonly log: Log
	) {
		this.log.info('Initializing tgstation test adapter');

		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.retireEmitter);
		this.disposables.push(this.cancelEmitter);
	}

	async load(): Promise<void> {
		if (this.isLoading){
			return;
		}

		this.isLoading = true;
		this.log.info('Loading tgstation tests');

		this.testsEmitter.fire({ type: 'started' });

		try{
			this.loadedTests = await loadTests();
			this.testsEmitter.fire({ type: 'finished', suite: this.loadedTests });
		} catch(e) {
			this.testsEmitter.fire({ type: 'finished', errorMessage: util.inspect(e)});
		}

		this.retireEmitter.fire({});

		this.isLoading = false;
	}

	async run(_tests: string[]): Promise<void> {
		if (this.loadedTests == undefined) {
			throw Error("Tests not loaded yet");
		}
		if (this.isRunning){
			return;
		}

		this.isRunning = true;

		let allTestSuites = this.loadedTests.children.map(suite => suite.id);
		this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests: allTestSuites });

		await runAllTests(this.loadedTests.children, this.testStatesEmitter, this.cancelEmitter);

		this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });

		this.isRunning = false;
	}

	cancel(): void {
		this.cancelEmitter.fire();
	}

	dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}
}
