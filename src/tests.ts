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
	} catch(err) {
		return false;
	}
}

async function mkDir(directory: string) {
	let direxists = await exists(directory);
	if(!direxists){
		await fsp.mkdir(directory);
	}
}

async function rmDir(directory: string) {
	let dirExists = await exists(directory);
	if(!dirExists){
		return;
	}
	let files = await fsp.readdir(directory);
	await Promise.all(
		files.map(file => fsp.unlink(path.join(directory, file)))
	);
	try{
		await fsp.unlink(directory);
	} catch {}
}
/*
function timeout(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
*/
export function getRoot(): vscode.Uri {
	let wsFolders = vscode.workspace.workspaceFolders;
	if (wsFolders == null) {
		throw Error("No workspace open");
	}
	return wsFolders[0].uri;
}

export function loadTests(): Promise<TestSuiteInfo> {
	let root = getRoot();

	let a = vscode.workspace.openTextDocument(vscode.Uri.parse(`${root}/code/modules/unit_tests/_unit_tests.dm`))
		.then(doc => {
			let text = doc.getText();
			let regexp = /#include "(\w+\.dm)"/gm;
			let match = regexp.exec(text);
			let test_files = [];
			while (match != null) {
				let test_name = match[1];
				if (test_name != "unit_test.dm") {
					test_files.push(test_name);
				}
				match = regexp.exec(text);
			}
			return test_files;
		})
		.then(test_files => {
			let regexp = /\/datum\/unit_test\/([\w\/]+)\/Run\s*\(/gm;
			let test_promises: Thenable<TestSuiteInfo>[] = [];
			test_files.forEach(test_file => {
				let file_uri = vscode.Uri.parse(`${root}/code/modules/unit_tests/${test_file}`);
				test_promises.push(vscode.workspace.openTextDocument(file_uri)
					.then(doc => {
						let text = doc.getText();
						let lines = text.split('\n');
						let lineNumber = 0;
						let tests: TestInfo[] = [];
						lines.forEach(line => {
							lineNumber++;
							let match = regexp.exec(line);
							if (match != null) {
								let test_name = match[1];
								tests.push({
									type: 'test',
									id: test_name,
									label: test_name,
									file: file_uri.fsPath,
									line: lineNumber
								});
							}
						});
						return tests;
					})
					.then((tests: TestInfo[]) => {
						let test_file_name = test_file.substring(0, test_file.length - 3);
						let suite: TestSuiteInfo = {
							type: 'suite',
							id: `suite_${test_file_name}`,
							label: test_file_name,
							file: file_uri.fsPath,
							children: tests
						}
						return suite;
					}));
			});
			return Promise.all(test_promises);
		})
		.then((testSuites: TestSuiteInfo[]) => {
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
		})

	return Promise.resolve(a);
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
		if(err != 'Canceled'){
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

	if (testLog == undefined) {
		return;
	}

	let passedTests = testLog.passed_tests;
	let failedTests = testLog.failed_tests;
	let skippedTests = allTests.filter(test => !passedTests.map(test => test.id).includes(test) && !failedTests.map(test => test.id).includes(test));

	passedTests.forEach(test => {
		testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'passed' });
	});
	failedTests.forEach(test => {
		testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'failed', message: test.comment });
	});
	skippedTests.forEach(test => {
		testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test, state: 'skipped' });
	});
}

async function getProjectName(){
	let dmefilename: string|undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('project.DMEName');
	if(dmefilename == undefined){
		throw Error(".dme name not set");
	}

	let root = getRoot();
	let dmeexists = await exists(`${root.fsPath}/${dmefilename}`);
	if(!dmeexists){
		throw Error(`${dmefilename} does not exist in the current workspace. You can change this in the Tgstation Test Explorer workspace settings.`);
	}
	
	let projectname = dmefilename.substring(0, dmefilename.length - 4);
	return projectname;
}

async function writeDefines(fd: fsp.FileHandle){
	let defines: string[]|undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('project.defines');
	if(defines == undefined){
		return;
	}
	
	for(const define of defines){
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

async function runProcess(command: string, args: string[], cancelEmitter: EventEmitter<void>){
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
	await daemon.waitForFinish();
}

async function compileDME(path: string, cancelEmitter: EventEmitter<void>) {
	/*
	let dmpath: string|undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('apps.dreammaker');
	if(dmpath == undefined){
		throw Error("Dreammaker path not set");
	}

	let stdout = await runProcess(dmpath, [path], cancelEmitter);
	if (/\.mdme\.dmb - 0 errors/.exec(stdout) == null) {
		throw new Error(`Compilation failed:\n${stdout}`);
	}
*/
	let root = getRoot();
	let projectName = await getProjectName();
	let testDMBPath = `${root.fsPath}/${projectName}.mdme.dmb`;
	return testDMBPath;
}

async function runDMB(path: string, cancelEmitter: EventEmitter<void>) {
	let root = getRoot();

	await rmDir(`${root.fsPath}/data/logs/unit_test`);
	await mkDir(`${root.fsPath}/data/logs/unit_test`); // Make empty dir so we have something to watch until the server starts populating it

	let ddpath: string|undefined = vscode.workspace.getConfiguration('tgstationTestExplorer').get('apps.dreamdaemon');
	if(ddpath == undefined){
		throw Error("Dreamdaemon path not set");
	}
	await runDaemonProcess(ddpath, [path, '-close', '-trusted', '-verbose', '-params', '"log-directory=unit_test"'], cancelEmitter);

}

interface PassedTest {
	id: string
}

interface FailedTest {
	id: string
	comment: string
}

interface TestLog {
	passed_tests: PassedTest[]
	failed_tests: FailedTest[]
}

async function readTestsLog(): Promise<TestLog> {
	let root = getRoot();
	let fdTestLog = await fsp.open(`${root.fsPath}/data/logs/unit_test/tests.log`, 'r');
	let buf = await fdTestLog.readFile();
	let text = buf.toString();
	let lines = text.split('\n');
	fdTestLog.close();

	let passed_tests: PassedTest[] = [];
	let failed_tests: FailedTest[] = [];
	let match;

	// Find passed tests
	let passRegexp = /PASS: \/datum\/unit_test\/([\w\/]+)/g;
	while ((match = passRegexp.exec(text)) != null) {
		passed_tests.push({ id: match[1] });
	}

	// Find failed tests
	let failRegexp = /FAIL: \/datum\/unit_test\/([\w\/]+)/g;
	let linenum = 0;
	while (linenum < lines.length) {
		let match = failRegexp.exec(lines[linenum]);
		if (match != null) {
			// Found a failed test. Begin iterating after the failed test line to consume the failed reason(s)
			let id = match[1];
			let commentlines = [];
			linenum++;
			let line: string;
			while ((line = lines[linenum]).substr(0, 1) != '[' && linenum < lines.length) {
				if (line.startsWith(' - \t')) {
					line = line.substring(4);
				}
				commentlines.push(line);
				linenum++;
			}
			failed_tests.push({
				id: id,
				comment: commentlines.join('\n')
			});
		} else {
			linenum++;
		}
	}

	return {
		passed_tests: passed_tests,
		failed_tests: failed_tests
	};
}
/*
async function cleanupTest(){
	let root = getRoot();
	let projectName = await getProjectName();
	await fsp.unlink(`${root.fsPath}/${projectName}.mdme.dmb`);
	await fsp.unlink(`${root.fsPath}/${projectName}.mdme.dme`);
	await fsp.unlink(`${root.fsPath}/${projectName}.mdme.dyn.rsc`);
	await fsp.unlink(`${root.fsPath}/${projectName}.mdme.rsc`);
}
*/
async function runTest(cancelEmitter: EventEmitter<void>): Promise<TestLog> {
	let testDMEPath = await makeTestDME();

	let testDMBPath = await compileDME(testDMEPath, cancelEmitter);

	await runDMB(testDMBPath, cancelEmitter);

	let testLog = await readTestsLog();

	//await cleanupTest();

	return testLog;
}
