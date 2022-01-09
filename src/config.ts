import { workspace } from 'vscode'
import { exists } from './utils';
import { ConfigError } from './error';

function getConfig<T>(section: string): T | undefined {
    return workspace.getConfiguration('tgstationTestExplorer').get(section)
}

export async function getDreamdaemonExecutable() {
    const ddpath: string | undefined = getConfig('apps.dreamdaemon');
    if (!ddpath) {
        throw new ConfigError("Dreamdaemon path not set");
    }
    if (!await exists(ddpath)) {
        throw new ConfigError(`Dreamdaemon not found at "${ddpath}"`);
    }
    return ddpath;
}

export async function getDreammakerExecutable() {
    const dmpath: string | undefined = getConfig('apps.dreammaker');
    if (!dmpath) {
        throw new ConfigError("Dreammaker (dm) path not set");
    }
    if (!await exists(dmpath)) {
        throw new ConfigError(`Dreammaker (dm) not found at "${dmpath}"`);
    }
    return dmpath;
}

export function getDefines() {
    const defines: string[] | undefined = getConfig('project.defines');
    if (!defines) {
        return [];
    }
    return defines;
}

export async function getDMEName() {
    const dmefilename: string | undefined = getConfig('project.DMEName');
    if (!dmefilename) {
        throw new ConfigError(".dme name not set");
    }
    const dmeFiles = await workspace.findFiles(`${dmefilename}`);
    if (dmeFiles.length == 0) {
        throw new ConfigError(`No .dme with name ${dmefilename} found in root folder.`);
    }
    return dmefilename;
}

export enum ResultType {
    Log = 'log',
    Json = 'json'
}

export function getResultsType() {
    const resultsTypeName: string = getConfig('project.resultsType') ?? 'log';
    switch (resultsTypeName) {
        case 'log':
            return ResultType.Log;
        case 'json':
            return ResultType.Json;
    }
    throw new ConfigError(`Unknown results type ${resultsTypeName}`);
}

const defaultRegex = /\/datum\/unit_test\/([\w\/]+)\/Run\s*\(/gm;
export function getUnitTestsDef() {
    let def: string | undefined = getConfig('project.unitTestsDefinitionRegex');
    if (!def) {
        return defaultRegex;
    }
    let regex: RegExp;
    try {
        regex = new RegExp(def, 'gm');
    } catch (err) {
        const error_message = typeof err === "string" ? err.toUpperCase() : (err instanceof Error ? err.message : "Unknown");
        throw new ConfigError(`Invalid regex for unit test definition. Message: ${error_message}`);
    }
    return regex;
}

const defaultFocusDefine = `TEST_FOCUS($0)`;
export function getFocusDefine() {
    let def: string | undefined = getConfig('project.unitTestsFocusDefine');
    if (!def) {
        return defaultFocusDefine;
    }
    if(!def.includes("$0")){
        throw new ConfigError(`Invalid unit test focus file definition. Definition must contain $0 for unit test typepath substitution.`);
    }
    return def;
}

export function getPreCompileCommands() {
    const commands: string[] | undefined = getConfig('project.preCompile');
    if (!commands) {
        return [];
    }
    return commands;
}
