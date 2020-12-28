import * as vscode from 'vscode';
import { TestSuiteInfo, TestInfo, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent } from 'vscode-test-adapter-api';
import * as child from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { EventEmitter } from 'vscode';
import { DreamDaemonProcess } from './DreamDaemonProcess';

async function exists(fileordir: string) {
	try {
		await fsp.access(fileordir);
		return true;
	} catch (err) {
		return false;
	}
}

async function mkDir(directory: string) {
	let direxists = await exists(directory);
	if (!direxists) {
		await fsp.mkdir(directory);
	}
}

async function rmDir(directory: string) {
	let dirExists = await exists(directory);
	if (!dirExists) {
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

export function getRoot(): vscode.Uri {
	let wsFolders = vscode.workspace.workspaceFolders;
	if (wsFolders == null) {
		throw Error("No workspace open");
	}
	return wsFolders[0].uri;
}

function removeExtension(file: string) {
	let parts = file.split('.');
	parts.pop();
	return parts.join('.');
}

function getFileFromPath(filePath: string) {
	let parts = filePath.split('/');
	return parts[parts.length - 1];
}

function trimStart(subject: string, text: string) {
	if (subject.startsWith(text)) {
		return subject.substring(text.length);
	}
	return subject;
}

interface FoundLine {
	match: RegExpExecArray,
	lineNumber: number
}

async function locateLineInFile(filePath: vscode.Uri, lineRegexp: RegExp) {
	const doc = await vscode.workspace.openTextDocument(filePath);
	const text = doc.getText();
	const lines = text.split('\n');

	let foundLines: FoundLine[] = [];

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

function getUnitTestsGlob() {
	let glob: string | undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('project.unitTestsDirectory');
	return glob ?? 'code/modules/unit_tests/*.dm';
}

function getUnitTestsDef() {
	let def: string | undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('project.unitTestsDefinitionRegex');
	if (!def) {
		return /\/datum\/unit_test\/([\w\/]+)\/Run\s*\(/gm;
	}
	return new RegExp(def, 'gm');
}

export async function loadTests() {
	const unitTestsDef = getUnitTestsDef();

	const uris = await vscode.workspace.findFiles(getUnitTestsGlob());
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
		if (err != 'Canceled') {
			if (err instanceof Error) {
				let errobj: Error = err;
				// The stack contain the name and message already, so if it exists we don't need to print them.
				err = errobj.stack ?? `${errobj.name}: ${errobj.message}`;
			}
			// Mark tests as errored if we catch an error
			allTests.forEach(test => {
				testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test, state: 'errored', message: err });
			})
		} else {
			allTests.forEach(test => {
				testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test, state: 'skipped' });
			});
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
	let dmefilename: string | undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('project.DMEName');
	if (dmefilename == undefined) {
		throw Error(".dme name not set");
	}

	let root = getRoot();
	let dmeexists = await exists(`${root.fsPath}/${dmefilename}`);
	if (!dmeexists) {
		throw Error(`${dmefilename} does not exist in the current workspace. You can change this in the Tgstation Test Explorer workspace settings.`);
	}

	let projectname = dmefilename.substring(0, dmefilename.length - 4);
	return projectname;
}

async function writeDefines(fd: fsp.FileHandle) {
	let defines: string[] | undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('project.defines');
	if (defines == undefined) {
		return;
	}

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
			reject(new Error("Canceled"));
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
		// Disposing the daemon object will cause the waitForFinish method to throw an "Canceled" error, thus this lets us exit early.
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

	let dmpath: string | undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('apps.dreammaker');
	if (dmpath == undefined) {
		throw Error("Dreammaker path not set");
	}

	let stdout = await runProcess(dmpath, [path], cancelEmitter);
	if (/\.mdme\.dmb - 0 errors/.exec(stdout) == null) {
		throw new Error(`Compilation failed:\n${stdout}`);
	}

	let root = getRoot();
	let projectName = await getProjectName();
	let testDMBPath = `${root.fsPath}/${projectName}.mdme.dmb`;
	return testDMBPath;
}

async function runDMB(path: string, cancelEmitter: EventEmitter<void>) {
	let root = getRoot();

	if (!await exists(path)) {
		throw Error(`Can't start dreamdaemon, ${path} does not exist!`);
	}

	await rmDir(`${root.fsPath}/data/logs/unit_test`);
	await mkDir(`${root.fsPath}/data`);
	await mkDir(`${root.fsPath}/data/logs`);
	await mkDir(`${root.fsPath}/data/logs/unit_test`); // Make empty dir so we have something to watch until the server starts populating it

	let ddpath: string | undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('apps.dreamdaemon');
	if (ddpath == undefined) {
		throw Error("Dreamdaemon path not set");
	}
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
	const fdTestLog = await fsp.open(`${root.fsPath}/data/unit_tests.json`, 'r');
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
	const fdTestLog = await fsp.open(`${root.fsPath}/data/logs/unit_test/tests.log`, 'r');
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
	const resultsType: string | undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('project.resultsType');
	switch (resultsType ?? 'log') {
		case 'log':
			return await readTestsLog();
		case 'json':
			return await readTestsJson();
		default:
			throw new Error(`Unknown results type ${resultsType}`);
	}
}

async function cleanupTest() {
	let root = getRoot();
	let projectName = await getProjectName();
	fsp.unlink(`${root.fsPath}/${projectName}.mdme.dmb`).catch(console.warn);
	fsp.unlink(`${root.fsPath}/${projectName}.mdme.dme`).catch(console.warn);
	fsp.unlink(`${root.fsPath}/${projectName}.mdme.dyn.rsc`).catch(console.warn);
	fsp.unlink(`${root.fsPath}/${projectName}.mdme.rsc`).catch(console.warn);
}

async function runTest(cancelEmitter: EventEmitter<void>): Promise<TestLog> {
	let testDMEPath = await makeTestDME();

	let testDMBPath = await compileDME(testDMEPath, cancelEmitter);

	await runDMB(testDMBPath, cancelEmitter);

	let testLog = await readTestsResults();

	await cleanupTest();

	return testLog;
}
