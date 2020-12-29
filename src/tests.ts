import * as vscode from 'vscode';
import { TestSuiteInfo, TestInfo, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent } from 'vscode-test-adapter-api';
import * as child from 'child_process';
import { promises as fsp } from 'fs';
import { EventEmitter } from 'vscode';
import { DreamDaemonProcess } from './DreamDaemonProcess';
import { exists, mkDir, rmDir, removeExtension, getFileFromPath, trimStart, rmFile } from './utils';
import * as config from './config';
import {UserError, ConfigError, CancelError, RunError} from './error';

const showInfo = vscode.window.showInformationMessage;
const showWarning = vscode.window.showWarningMessage;
const showError = vscode.window.showErrorMessage;

export function getRoot(): vscode.Uri {
	let wsFolders = vscode.workspace.workspaceFolders;
	if (wsFolders == null) {
		throw new UserError("No workspace open");
	}
	return wsFolders[0].uri;
}

interface FoundLine {
	match: RegExpExecArray,
	lineNumber: number
}

async function locateLineInFile(filePath: vscode.Uri, lineRegexp: RegExp) {
	const doc = await vscode.workspace.openTextDocument(filePath);
	const text = doc.getText();
	const lines = text.split('\n');

	const foundLines: FoundLine[] = [];

	let lineNumber = 0;
	lines.forEach(line => {
		lineNumber++;
		const match = lineRegexp.exec(line);
		if (match != null) {
			foundLines.push({ match, lineNumber });
		}
	});

	return foundLines;
}

async function locateTestsInFile(filePath: vscode.Uri, lineRegexp: RegExp) {
	const tests: TestInfo[] = [];

	const testLines = await locateLineInFile(filePath, lineRegexp);
	for (const testLine of testLines) {
		const testName = testLine.match[1];
		if (testName === 'proc') {
			continue;
		}
		tests.push({
			type: 'test',
			id: testName,
			label: testName,
			file: filePath.toString(),
			line: testLine.lineNumber
		});
	}

	let suiteName = removeExtension(getFileFromPath(filePath.path));
	let suite: TestSuiteInfo = {
		type: 'suite',
		id: `suite_${suiteName}`,
		label: suiteName,
		file: filePath.toString(),
		children: tests
	}

	return suite;
}

export async function loadTests() {
	const unitTestsDef = config.getUnitTestsDef();

	const uris = await vscode.workspace.findFiles(config.getUnitTestsGlob());
	let testSuites = await Promise.all(uris.map(uri => locateTestsInFile(uri, unitTestsDef)));

	// Filter out suites without any tests
	testSuites = testSuites.filter(val => {
		return val.children.length > 0;
	});

	// Sort suites
	testSuites = testSuites.sort((a, b) => {
		return a.label.localeCompare(b.label);
	});

	const rootSuite: TestSuiteInfo = {
		type: 'suite',
		id: 'root',
		label: 'DM',
		children: testSuites
	};

	return rootSuite;
}

export async function runAllTests(
	tests: (TestSuiteInfo | TestInfo)[],
	testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>,
	cancelEmitter: EventEmitter<void>
): Promise<void> {

	let allTests: string[] = [];

	tests.forEach(suiteortest => {
		let suite = suiteortest as TestSuiteInfo;
		testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: suite.id, state: 'running' });
		suite.children.forEach(test => {
			testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'running' });
			allTests.push(test.id);
		})
	})

	let testLog: TestLog | undefined;
	try {
		testLog = await runTest(cancelEmitter);
	}
	catch (err) {
		if (err instanceof CancelError) {
			allTests.forEach(test => {
				testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test, state: 'skipped' });
			});
		} else {
			if (err instanceof Error) {
				if (err instanceof RunError) {
					showError("Test Explorer: Test run failed, click one of the test items in the Test Explorer to see more.");
				} else if (err instanceof UserError || err instanceof ConfigError) {
					showError(`Test Explorer: ${err.message}`);
				}

				let errobj: Error = err;
				// The stack contain the name and message already, so if it exists we don't need to print them.
				err = errobj.stack ?? `${errobj.name}: ${errobj.message}`;
			}

			// Mark tests as errored if we catch an error
			allTests.forEach(test => {
				testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test, state: 'errored', message: err });
			})
		}
	}

	// Mark suites as completed no matter what the outcome
	tests.forEach(suiteortest => {
		let suite = suiteortest as TestSuiteInfo;
		testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: suite.id, state: 'completed' });
	})

	if (!testLog) {
		return;
	}

	let passedTests = testLog.passed_tests;
	let failedTests = testLog.failed_tests;
	// Skipped tests are any tests where skip is explicitly called.
	let skippedTests = testLog.skipped_tests;
	// Ignored tests are any tests we expected to find in the results but didn't. These will be marked as skipped in the UI.
	let ignoredTests = allTests.filter(test =>
		!passedTests.map(test => test.id).includes(test) &&
		!failedTests.map(test => test.id).includes(test) &&
		!skippedTests.map(test => test.id).includes(test)
	);

	passedTests.forEach(test => {
		testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'passed' });
	});
	failedTests.forEach(test => {
		testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'failed', message: test.message });
	});
	skippedTests.forEach(test => {
		testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'skipped', message: test.message });
	});
	ignoredTests.forEach(test => {
		testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test, state: 'skipped' });
	});
}

async function getProjectName() {
	const dmefilename = await config.getDMEName();
	const projectname = removeExtension(dmefilename);
	return projectname;
}

async function writeDefines(fd: fsp.FileHandle) {
	const defines = config.getDefines();
	for (const define of defines) {
		await fd.write(`${define}\n`);
	}
}

async function makeTestDME() {
	let root = getRoot();
	let projectName = await getProjectName();
	let testDMEPath = `${root.fsPath}/${projectName}.mdme.dme`;

	let fdNew = await fsp.open(testDMEPath, 'w');
	let fdOrig = await fsp.open(`${root.fsPath}/${projectName}.dme`, 'r');

	await writeDefines(fdNew);

	await fdOrig.readFile()
		.then(buf => {
			fdNew.write(buf);
		});

	fdNew.close();
	fdOrig.close();

	return testDMEPath;
}

async function runProcess(command: string, args: string[], cancelEmitter: EventEmitter<void>) {
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

async function runDaemonProcess(command: string, args: string[], cancelEmitter: EventEmitter<void>) {
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

async function compileDME(path: string, cancelEmitter: EventEmitter<void>) {
	const dmpath = await config.getDreammakerExecutable();
	let stdout = await runProcess(dmpath, [path], cancelEmitter);
	if (/\.mdme\.dmb - 0 errors/.exec(stdout) == null) {
		throw new RunError(`Compilation failed:\n${stdout}`);
	}

	let root = getRoot();
	let projectName = await getProjectName();
	let testDMBPath = `${root.fsPath}/${projectName}.mdme.dmb`;
	return testDMBPath;
}

async function runDMB(path: string, cancelEmitter: EventEmitter<void>) {
	let root = getRoot();

	if (!await exists(path)) {
		throw new RunError(`Can't start dreamdaemon, "${path}" does not exist!`);
	}

	await rmDir(`${root.fsPath}/data/logs/unit_test`);
	await mkDir(`${root.fsPath}/data`);
	await mkDir(`${root.fsPath}/data/logs`);
	await mkDir(`${root.fsPath}/data/logs/unit_test`); // Make empty dir so we have something to watch until the server starts populating it

	const ddpath = await config.getDreamdaemonExecutable();
	await runDaemonProcess(ddpath, [path, '-close', '-trusted', '-verbose', '-params', '"log-directory=unit_test"'], cancelEmitter);
}

interface TestResult {
	id: string,
	message?: string
}

class TestLog {
	readonly passed_tests: TestResult[] = [];
	readonly failed_tests: TestResult[] = [];
	readonly skipped_tests: TestResult[] = [];
}

enum TestStatus {
	Passed = 0,
	Failed = 1,
	Skipped = 2
}

type TestLogResult = {
	status: TestStatus,
	message: string,
	name: string
}

async function readTestsJson() {
	const root = getRoot();
	const testsFilepath = `${root.fsPath}/data/unit_tests.json`;
	if(!await exists(testsFilepath)){
		throw new ConfigError(`"${testsFilepath}" not found after run. Make sure Results Type is set properly in config, and that the unit tests have actually been run.`);
	}
	const fdTestLog = await fsp.open(testsFilepath, 'r');
	const buf = await fdTestLog.readFile();
	const results: { [key: string]: TestLogResult } = JSON.parse(buf.toString());

	await fdTestLog.close();

	const testlog = new TestLog();
	for (const type in results) {
		const data = results[type];
		const result = <TestResult>{
			id: trimStart(type, '/datum/unit_test/'),
			message: data.message
		};
		switch (data.status) {
			case TestStatus.Passed:
				testlog.passed_tests.push(result);
				break;
			case TestStatus.Failed:
				testlog.failed_tests.push(result);
				break;
			case TestStatus.Skipped:
				testlog.skipped_tests.push(result);
				break;
		}
	}

	return testlog;
}

async function readTestsLog() {
	const root = getRoot();
	const testsFilepath = `${root.fsPath}/data/logs/unit_test/tests.log`;
	if(!await exists(testsFilepath)){
		throw new ConfigError(`"${testsFilepath}" not found after run. Make sure Results Type is set properly in config, and that the unit tests have actually been run.`);
	}
	const fdTestLog = await fsp.open(testsFilepath, 'r');
	const buf = await fdTestLog.readFile();
	const text = buf.toString();
	await fdTestLog.close();

	const testlog = new TestLog();
	let match;
	// Find passed tests
	const passRegexp = /PASS: \/datum\/unit_test\/([\w\/]+)/g;
	while ((match = passRegexp.exec(text)) != null) {
		testlog.passed_tests.push({ id: match[1] });
	}
	// Find failed tests
	const failRegexp = /FAIL: \/datum\/unit_test\/([\w\/]+)/g;
	const lines = text.split('\n');
	let linenum = 0;
	while (linenum < lines.length) {
		const match = failRegexp.exec(lines[linenum]);
		if (match != null) {
			// Found a failed test. Begin iterating after the failed test line to consume the failed reason(s)
			const id = match[1];
			const commentlines = [];
			linenum++;
			let line: string;
			while ((line = lines[linenum]).substr(0, 1) != '[' && linenum < lines.length) {
				if (line.startsWith(' - \t')) {
					line = line.substring(4);
				}
				commentlines.push(line);
				linenum++;
			}
			testlog.failed_tests.push({
				id: id,
				message: commentlines.join('\n')
			});
		} else {
			linenum++;
		}
	}
	return testlog;
}

async function readTestsResults() {
	switch (config.getResultsType()) {
		case config.ResultType.Log:
			return await readTestsLog();
		case config.ResultType.Json:
			return await readTestsJson();
	}
}

async function cleanupTest() {
	let root = getRoot();
	let projectName = await getProjectName();
	rmFile(`${root.fsPath}/${projectName}.mdme.dmb`).catch(console.warn);
	rmFile(`${root.fsPath}/${projectName}.mdme.dme`).catch(console.warn);
	rmFile(`${root.fsPath}/${projectName}.mdme.dyn.rsc`).catch(console.warn);
	rmFile(`${root.fsPath}/${projectName}.mdme.rsc`).catch(console.warn);
}

async function runTest(cancelEmitter: EventEmitter<void>): Promise<TestLog> {
	let testDMEPath = await makeTestDME();

	let testDMBPath = await compileDME(testDMEPath, cancelEmitter);

	await runDMB(testDMBPath, cancelEmitter);

	let testLog = await readTestsResults();

	await cleanupTest();

	return testLog;
}
