import * as vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { Log, TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { DMAdapter } from './adapter';

export async function activate(context: vscode.ExtensionContext) {
	const log = new Log('tgstationTestExplorer', undefined, 'Tgstation Test Explorer Log');
	context.subscriptions.push(log);

	const testExplorerExtension = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId);
	if (testExplorerExtension) {
		log.info(`Activation: Test Explorer found`);
	} else {
		log.error(`Activation: Test Explorer not found`);
	}

	if (testExplorerExtension) {
		const testHub = testExplorerExtension.exports;

		// Register an adapter for each workspace folder
		context.subscriptions.push(new TestAdapterRegistrar(
			testHub,
			workspaceFolder => new DMAdapter(workspaceFolder, log),
			log
		));
	}
}
