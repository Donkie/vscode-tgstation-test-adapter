import * as vscode from 'vscode';
import { TestSuiteInfo, TestInfo, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent } from 'vscode-test-adapter-api';
import { promises as fsp } from 'fs';
import { EventEmitter } from 'vscode';
import { runDreamDaemonProcess } from './DreamDaemonProcess';
import { exists, mkDir, rmDir, removeExtension, getFileFromPath, trimStart, rmFile, runProcess, durationToString } from './utils';
import * as config from './config';
import {UserError, ConfigError, CancelError, RunError} from './error';
import { Log } from 'vscode-test-adapter-util';

const showError = vscode.window.showErrorMessage;

/**
 * Represents a found line, returned by locateLineInFile.
 */
interface FoundLine {
	match: RegExpExecArray,
	lineNumber: number
}

/**
 * Scans the file and tries to match each line with the supplied regex. Lines that match will be returned.
 * @param filePath The file to scan.
 * @param lineRegexp The regex to match each line with.
 */
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

/**
 * Locates any test definitions in a file.
 * @param filePath The file to scan.
 * @param lineRegexp The regex used to match test definitions. Must contain one capture group which represents the test id.
 */
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

/**
 * Scans the workspace for any unit test definitions.
 */
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

/**
 * Runs the unit test.
 * @param tests Test suites to run.
 * @param testStatesEmitter Emitter used to indicate the progress and results of the test .
 * @param cancelEmitter Emitter used to prematurely cancel the test run.
 */
export async function runAllTests(
	tests: (TestSuiteInfo | TestInfo)[],
	testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>,
	cancelEmitter: EventEmitter<void>,
	workspace: vscode.WorkspaceFolder,
	log: Log
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
		testLog = await runTest(cancelEmitter, workspace, log);
	}
	catch (err) {
		if (err instanceof CancelError) {
			log.info("Test run cancelled")
			allTests.forEach(test => {
				testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test, state: 'skipped' });
			});
		} else {
			if (err instanceof Error) {
				let errobj: Error = err;
				let errmsg: string;
				if (err instanceof RunError) {
					errmsg = 'Test run failed, click one of the test items in the Test Explorer to see more.';
				} else if (err instanceof ConfigError) {
					errmsg = `${err.message}\nPlease confirm that the workspace and/or user configuration is correct.`;
				} else if (err instanceof UserError) {
					errmsg = err.message;
				} else {
					errmsg = `An unexpected error has occured, click one of the test items in the Test Explorer to see more. Please report this on the issue tracker!\n${errobj.name}: ${errobj.message}`;
				}
				showError(`Test Explorer: ${errmsg}`);

				// The stack contain the name and message already, so if it exists we don't need to print them.
				err = errobj.stack ?? `${errobj.name}: ${errobj.message}`;
			}
			log.error(`Test run errored.\n${err}`);

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

	const numPass = passedTests.length;
	const numSkip = skippedTests.length
	const numTot = numPass + failedTests.length;
	log.info(`${numPass}/${numTot} tests passed.${
		numSkip > 0 ? 
			` ${numSkip} ${
				numSkip == 1 ?
					'test was' :
					'tests were'} skipped.` :
			''}`);
}

/**
 * Gets the "project name" of the workspace folder, this is the "tgstation" part of "tgstation.dme".
 */
async function getProjectName() {
	const dmefilename = await config.getDMEName();
	const projectname = removeExtension(dmefilename);
	return projectname;
}

/**
 * Writes the defines specified in config to the file.
 * @param fd The file to write to.
 */
async function writeDefines(fd: fsp.FileHandle) {
	const defines = config.getDefines();
	for (const define of defines) {
		await fd.write(`${define}\n`);
	}
}

/**
 * Copies the project .dme, applies the defines in the beginning and returns the path to this new .dme.
 */
async function makeTestDME(workspace: vscode.WorkspaceFolder) {
	let projectName = await getProjectName();
	let testDMEPath = `${workspace.uri.fsPath}/${projectName}.mdme.dme`;

	let fdNew = await fsp.open(testDMEPath, 'w');
	let fdOrig = await fsp.open(`${workspace.uri.fsPath}/${projectName}.dme`, 'r');

	await writeDefines(fdNew);

	await fdOrig.readFile()
		.then(buf => {
			fdNew.write(buf);
		});

	fdNew.close();
	fdOrig.close();

	return testDMEPath;
}

/**
 * Compiles a .dme using dreammaker. Returns the path to the compiled .dmb file.
 * @param path The path to the .dme to compile.
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the compilation.
 */
async function compileDME(path: string, workspace: vscode.WorkspaceFolder, cancelEmitter: EventEmitter<void>) {
	const dmpath = await config.getDreammakerExecutable();
	let stdout = await runProcess(dmpath, [path], cancelEmitter);
	if (/\.mdme\.dmb - 0 errors/.exec(stdout) == null) {
		throw new RunError(`Compilation failed:\n${stdout}`);
	}

	let projectName = await getProjectName();
	let testDMBPath = `${workspace.uri.fsPath}/${projectName}.mdme.dmb`;
	return testDMBPath;
}

/**
 * Runs the dreamdaemon with the specified .dmb file.
 * @param path The .dmb file to run.
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the run.
 */
async function runDMB(path: string, workspace: vscode.WorkspaceFolder, cancelEmitter: EventEmitter<void>) {
	if (!await exists(path)) {
		throw new RunError(`Can't start dreamdaemon, "${path}" does not exist!`);
	}

	const root = workspace.uri.fsPath;
	await mkDir(`${root}/data`);
	await mkDir(`${root}/data/logs`);
	const resultsType = config.getResultsType();
	switch (resultsType) {
		case config.ResultType.Log:
			await rmDir(`${root}/data/logs/unit_test`);
			await mkDir(`${root}/data/logs/unit_test`);
			break;
		case config.ResultType.Json:
			await rmFile(`${root}/data/unit_tests.json`);
			break;
	}

	const ddpath = await config.getDreamdaemonExecutable();
	const args = [path, '-close', '-trusted', '-verbose'];
	if(resultsType === config.ResultType.Log){
		args.push('-params', '"log-directory=unit_test"');
	}
	await runDreamDaemonProcess(ddpath, args, cancelEmitter);
}

/**
 * Represents an internal test result.
 */
interface TestResult {
	id: string,
	message?: string
}

/**
 * Represents a set of test results.
 */
class TestLog {
	readonly passed_tests: TestResult[] = [];
	readonly failed_tests: TestResult[] = [];
	readonly skipped_tests: TestResult[] = [];
}

/**
 * Represents the state of a test result.
 */
enum TestStatus {
	Passed = 0,
	Failed = 1,
	Skipped = 2
}

/**
 * Represents the objects found in the unit tests json file.
 */
type TestLogResult = {
	status: TestStatus,
	message: string,
	name: string
}

/**
 * Read test results from a json file.
 */
async function readTestsJson(workspace: vscode.WorkspaceFolder) {
	const testsFilepath = `${workspace.uri.fsPath}/data/unit_tests.json`;
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

/**
 * Read test results from a log file.
 */
async function readTestsLog(workspace: vscode.WorkspaceFolder) {
	const testsFilepath = `${workspace.uri.fsPath}/data/logs/unit_test/tests.log`;
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

/**
 * Read test results based on ResultsType config setting.
 */
async function readTestsResults(workspace: vscode.WorkspaceFolder) {
	switch (config.getResultsType()) {
		case config.ResultType.Log:
			return await readTestsLog(workspace);
		case config.ResultType.Json:
			return await readTestsJson(workspace);
	}
}

/**
 * Cleans up any remaining files and folders after a test run
 */
async function cleanupTest(workspace: vscode.WorkspaceFolder) {
	const root = workspace.uri.fsPath;
	let projectName = await getProjectName();
	rmFile(`${root}/${projectName}.mdme.dmb`).catch(console.warn);
	rmFile(`${root}/${projectName}.mdme.dme`).catch(console.warn);
	rmFile(`${root}/${projectName}.mdme.dyn.rsc`).catch(console.warn);
	rmFile(`${root}/${projectName}.mdme.rsc`).catch(console.warn);
}

/**
 * Performs a test run
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the test run.
 */
async function runTest(cancelEmitter: EventEmitter<void>, workspace: vscode.WorkspaceFolder, log: Log): Promise<TestLog> {
	log.info('Compiling...');
	const compileStart = Date.now();

	let testDMEPath = await makeTestDME(workspace);
	let testDMBPath = await compileDME(testDMEPath, workspace, cancelEmitter);

	log.info(`Compile finished! Time: ${durationToString(compileStart)}`);
	log.info('Running server unit test run...');
	const runStart = Date.now();

	await runDMB(testDMBPath, workspace, cancelEmitter);

	log.info(`Server unit test run finished! Time: ${durationToString(runStart)}`);

	let testLog = await readTestsResults(workspace);

	await cleanupTest(workspace);

	return testLog;
}
