import { workspace } from 'vscode'
import { exists } from './utils';

function getConfig<T>(section: string): T | undefined {
    return workspace.getConfiguration('tgstationTestExplorer').get(section)
}

export async function getDreamdaemonExecutable() {
    const ddpath: string | undefined = getConfig('apps.dreamdaemon');
    if (!ddpath) {
        throw Error("Dreamdaemon path not set");
    }
    if (!await exists(ddpath)) {
        throw Error(`Dreamdaemon not found at "${ddpath}"`);
    }
    return ddpath;
}

export async function getDreammakerExecutable() {
    const dmpath: string | undefined = getConfig('apps.dreammaker');
    if (!dmpath) {
        throw Error("Dreammaker (dm) path not set");
    }
    if (!await exists(dmpath)) {
        throw Error(`Dreammaker (dm) not found at "${dmpath}"`);
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
        throw Error(".dme name not set");
    }
    const dmeFiles = await workspace.findFiles(`/${dmefilename}`);
    if (dmeFiles.length == 0) {
        throw Error(`No .dme with name ${dmefilename} found in root folder.`);
    }
    return dmefilename;
}

export enum ResultType {
    Log = 'log',
    Json = 'json'
}

export function getResultsType() {
    const resultsTypeName: string = getConfig('project.resultsType') ?? 'log';
    const resultsType: ResultType = (<any>ResultType)[resultsTypeName];
    if (!resultsType) {
        throw new Error(`Unknown results type ${resultsTypeName}`);
    }
    return resultsType;
}

export function getUnitTestsGlob() {
    let glob: string | undefined = getConfig('project.unitTestsDirectory');
    return glob ?? 'code/modules/unit_tests/*.dm';
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
        throw Error(`Invalid regex for unit test definition. Message: ${err.message}`);
    }
    return regex;
}