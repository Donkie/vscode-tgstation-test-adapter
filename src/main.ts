import * as vscode from 'vscode';
import { loadTests, runTests } from './tests';

export async function activate(context: vscode.ExtensionContext) {
	const controller = vscode.tests.createTestController('tgstationTestExplorer','Tgstation Test Controller')
	context.subscriptions.push(controller);

	controller.resolveHandler = async test => {
		if(!test){
			const rootSuite = controller.createTestItem('root','All tests',undefined);
			rootSuite.canResolveChildren = true;
			controller.items.replace([rootSuite]);
		}
		if(test && test.id == 'root'){
			const allTests = await loadTests(controller);
			test.children.replace(allTests);
		}
	}

	controller.createRunProfile('Run',vscode.TestRunProfileKind.Run,(request,token) => runTests(controller,request,token),true);
}

