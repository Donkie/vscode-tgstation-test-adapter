import * as vscode from 'vscode';
import { promises as fsp } from 'fs';
import { EventEmitter } from 'vscode';
import { runDreamDaemonProcess } from './DreamDaemonProcess';
import { exists, mkDir, rmDir, removeExtension, getFileFromPath, trimStart, rmFile, runProcess, exec, durationToString} from './utils';
import * as config from './config';
import { ConfigError, RunError } from './error';
import { getDMBlockvars, lineIsDatumDefinition } from './dm';
import { getPreCompileCommands } from './config';

/**
 * Represents a found line, returned by locateLineInFile.
 */
interface FoundLine {
	match: RegExpExecArray,
	line: vscode.TextLine
}

function testHasTemplate(lines: string[], testStart: number) {
	if (testStart >= (lines.length - 1)) {
		return false;
	}

	const vars = getDMBlockvars(lines, testStart + 1);
	if ('template' in vars) {
		const templateName = vars['template'].trim();
		const datumName = lines[testStart].trim();
		return templateName === datumName;
	}
	return false;
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

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber];
		const match = lineRegexp.exec(line);
		if (match != null) {
			const isDatumDef = lineIsDatumDefinition(line);
			if (!isDatumDef || (isDatumDef && !testHasTemplate(lines, lineNumber))) {
				const line = doc.lineAt(lineNumber);
				foundLines.push({ match, line });
			}
		}
	};

	return foundLines;
}

/**
 * Locates any test definitions in a file.
 * @param filePath The file to scan.
 * @param lineRegexp The regex used to match test definitions. Must contain one capture group which represents the test id.
 */
async function locateTestsInFile(filePath: vscode.Uri, lineRegexp: RegExp, controller: vscode.TestController, output: vscode.OutputChannel) {
	const tests: vscode.TestItem[] = [];
	output.appendLine(`Parsing file: ${filePath}`)
	const testLines = await locateLineInFile(filePath, lineRegexp);
	for (const testLine of testLines) {
		const testName = testLine.match[1];
		if (testName === 'proc') {
			continue;
		}
		const item = controller.createTestItem(testName,testName,filePath)
		item.range = testLine.line.range
		testData.set(item, { typepath: `/datum/unit_test/${testName}` }); //This could possibly be configable but it's already hardcoded in few places so left it as is
		tests.push(item);
	}
	output.appendLine(`Finished file: ${filePath}`)
	if(tests.length > 0){
		let suiteName = removeExtension(getFileFromPath(filePath.path));
		let suite = controller.createTestItem(`suite_${suiteName}`,suiteName,filePath);
		suite.children.replace(tests);
		return suite;
	}

	return null;
}

/// Auxiliary test item data
interface DmTestData {
	typepath: string
}

const testData = new WeakMap<vscode.TestItem, DmTestData>();

/**
 * Scans the workspace for any unit test definitions.
 */
export async function loadTests(controller: vscode.TestController) {
	const unitTestsDef = config.getUnitTestsDef();

	const debug_output = vscode.window.createOutputChannel("Tgstation Test Extension Log");

	const uris = await vscode.workspace.findFiles("**/*.dm");
	
	/// We limit it to 10 files at once otherwise vscode gets a stroke.
	let testSuites : vscode.TestItem[] = [];
	await parallel(10,uris,async uri => {
		const test = await locateTestsInFile(uri,unitTestsDef,controller,debug_output);
		if(test)
			testSuites.push(test)
	})

	// Filter out suites without any tests
	testSuites = testSuites.filter(val => {
		return val.children.size > 0;
	});

	// Sort suites
	testSuites = testSuites.sort((a, b) => {
		return a.label.localeCompare(b.label);
	});

	return testSuites;
}


export async function parallel<T>(concurrent: number, collection: Iterable<T>, processor: (item: T) => Promise<any>) {
	// queue up simultaneous calls
	const queue: Promise<any>[] = [];
	const ret = [];
	for (const fn of collection) {
		// fire the async function, add its promise to the queue, and remove
		// it from queue when complete
		const p = processor(fn).then(res => {
			queue.splice(queue.indexOf(p), 1);
			return res;
		});
		queue.push(p);
		ret.push(p);
		// if max concurrent, wait for one to finish
		if (queue.length >= concurrent) {
			await Promise.race(queue);
		}
	}
	// wait for the rest of the calls to finish
	await Promise.all(queue);
}

export async function runTests(
	controller: vscode.TestController,
	request: vscode.TestRunRequest,
	token: vscode.CancellationToken
): Promise<void> {
	const run = controller.createTestRun(request);

	// collect tests to run
	/// By default we run all tests, if request.includes is defined just these
	let tests_to_run : vscode.TestItem[] = [];
	if(request.include){
		tests_to_run = request.include
	}
	else{
		controller.items.forEach(top_level_item => tests_to_run.push(top_level_item))
	}
	//skip anything in request.excludes
	if(request.exclude){
		tests_to_run = tests_to_run.filter(test => !request.exclude?.includes(test))
	}

	//Collect children items from top level ones (skipping ones in exclude)
	tests_to_run = collectTestItems(tests_to_run, request);

	if(tests_to_run.length <= 0){
		run.appendOutput("Test run cancelled: no tests in the run.\r\n")
		run.end();
		return;
	}
	run.appendOutput(`Starting test run with ${tests_to_run.length} tests.\r\n`)

	const first_uri = tests_to_run.find(x => x.uri !== undefined)?.uri! ///AAAH
	const workspace = vscode.workspace.getWorkspaceFolder(first_uri)!;

	run.appendOutput(`Used workspace path: ${workspace.uri.fsPath}\r\n`)
	
	//should be just rewritten to use tokens directly but i'm lazy
	const cancelEmitter = new vscode.EventEmitter<void>()
	token.onCancellationRequested(() => cancelEmitter.fire())

	// prepare test run dme
	await runPreCompileCommands(workspace, cancelEmitter, run);
	run.appendOutput('Compiling...\r\n');
	const compileStart = Date.now();
	let testDMEPath = await makeTestDME(workspace,tests_to_run);
	let testDMBPath = await compileDME(testDMEPath, workspace, cancelEmitter, run);
	
	run.appendOutput(`Compile finished! Time: ${durationToString(compileStart)}\r\n`);
	run.appendOutput('Running server unit test run...\r\n');
	const runStart = Date.now();
	
	tests_to_run.map(test => run.started(test)); // Could be made to watch the output file to be more precise
	
	await runDMB(testDMBPath, workspace, cancelEmitter, run);
	
	run.appendOutput(`Server unit test run finished! Time: ${durationToString(runStart)}\r\n`);
	let testLog = await readTestsResults(workspace);

	tests_to_run.forEach(test =>{
		const failed_result = testLog.failed_tests.find(x => x.id == test.id);
		if(failed_result)
		{
			run.failed(test,new vscode.TestMessage(failed_result.message ?? ""));
			return;
		}
		const passed_result = testLog.passed_tests.find(x => x.id == test.id);
		if(passed_result)
		{
			run.passed(test);
			return;
		}
		const skipped_result = testLog.skipped_tests.find(x => x.id == test.id);
		if(skipped_result)
		{
			run.failed(test,new vscode.TestMessage(skipped_result.message ?? ""));
			return;
		}
	})

	await cleanupTest(workspace);

	run.end();
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
 * Writes the unit test focus file contents - each define marks a unit test to execute
 * @param fd The file to write to.
 */
async function writeFocusFileContents(fd: fsp.FileHandle,tests_to_run : vscode.TestItem[]) {
	const focus_define = config.getFocusDefine();
	for (const test of tests_to_run) {
		const test_path = testData.get(test)?.typepath;
		if(test_path){
			await fd.write(`${focus_define.replace("$0",test_path)}\n`);
		}
	}
}

/**
 * Copies the project .dme, applies the defines in the beginning and returns the path to this new .dme.
 */
async function makeTestDME(workspace: vscode.WorkspaceFolder, tests_to_run : vscode.TestItem[]) {
	let projectName = await getProjectName();
	let testDMEPath = `${workspace.uri.fsPath}/${projectName}.test.dme`;
	let focusFilePath = `${workspace.uri.fsPath}/${projectName}_unit_test_focus_file.dm`

	let fdNew = await fsp.open(testDMEPath, 'w');
	let fdOrig = await fsp.open(`${workspace.uri.fsPath}/${projectName}.dme`, 'r');
	let focusFile = await fsp.open(focusFilePath, 'w')

	await writeDefines(fdNew);
	await writeFocusFileContents(focusFile,tests_to_run)

	await fdOrig.readFile()
		.then(buf => {
			fdNew.write(buf);
		});

	await fdNew.write(`#include "${projectName}_unit_test_focus_file.dm"\n`)

	fdNew.close();
	fdOrig.close();
	focusFile.close()

	return testDMEPath;
}

/**
 * Compiles a .dme using dreammaker. Returns the path to the compiled .dmb file.
 * @param path The path to the .dme to compile.
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the compilation.
 */
async function compileDME(path: string, workspace: vscode.WorkspaceFolder, cancelEmitter: EventEmitter<void>, run : vscode.TestRun) {
	const dmpath = await config.getDreammakerExecutable();
	let stdout = await runProcess(dmpath, [path], cancelEmitter);
	if (/\.test\.dmb - 0 errors/.exec(stdout) == null) {
		run.appendOutput(`Compilation failed:\n${stdout}`);
		await cleanupTest(workspace);
		run.end();
		throw new RunError(`Compilation failed:\n${stdout}`);
	}

	let projectName = await getProjectName();
	let testDMBPath = `${workspace.uri.fsPath}/${projectName}.test.dmb`;
	return testDMBPath;
}

/**
 * Runs the dreamdaemon with the specified .dmb file.
 * @param path The .dmb file to run.
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the run.
 */
async function runDMB(path: string, workspace: vscode.WorkspaceFolder, cancelEmitter: EventEmitter<void>, run : vscode.TestRun) {
	if (!await exists(path)) {
		run.appendOutput(`Can't start dreamdaemon, "${path}" does not exist!`);
		await cleanupTest(workspace);
		run.end();
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
	const args = [`"${path}"`, '-close', '-trusted', '-verbose'];
	if (resultsType === config.ResultType.Log) {
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
	if (!await exists(testsFilepath)) {
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
	if (!await exists(testsFilepath)) {
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
	rmFile(`${root}/${projectName}.test.dmb`).catch(console.warn);
	rmFile(`${root}/${projectName}.test.dme`).catch(console.warn);
	rmFile(`${root}/${projectName}.test.dyn.rsc`).catch(console.warn);
	rmFile(`${root}/${projectName}.test.rsc`).catch(console.warn);
	rmFile(`${root}/${projectName}_unit_test_focus_file.dm`).catch(console.warn);
}

async function runPreCompileCommands(workspace: vscode.WorkspaceFolder, cancelEmitter: EventEmitter<void>, run : vscode.TestRun){
	const commands = getPreCompileCommands();
	if(commands.length > 0){
		run.appendOutput("Running pre-compile commands...\r\n");

		for(var command of commands){
			run.appendOutput(`Executing "${command}"\r\n`);
			if(process.platform === "win32"){
				command = "call " + command; // Absolutely awful
			}
			const out = await exec(command, workspace.uri.fsPath, cancelEmitter);
			if(out.length > 0){
				run.appendOutput(`${out}\r\n`);
			}
		}

		run.appendOutput("Finished running pre-compile commands.\r\n");
	}
}

function collectTestItems(top_level_tests: vscode.TestItem[], request: vscode.TestRunRequest): vscode.TestItem[] {
	const result : vscode.TestItem[] = [];
	top_level_tests.forEach(x => {
		if(request.exclude?.includes(x))
			return;
		result.push(x);
		if(x.children.size > 0){
			const test_children : vscode.TestItem[] = [];
			x.children.forEach(child => test_children.push(child));
			result.push(...collectTestItems(test_children,request))
		}
	})
	return result;
}