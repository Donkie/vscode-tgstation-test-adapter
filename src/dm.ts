

const isLevel1Block = /^(?:\t[^\t].+|[\s]*)[\r\n]*$/;
/**
 * Scans an array of DM code lines and returns a slice of the lines containing the "code block" which started at line `blockStart`.
 * @param lines The lines to scan
 * @param blockStart The start of the block to return
 */
function getDMBlock(lines: string[], blockStart: number): string[] {
    let blockEnd = lines.length;

    for (let lineNumber = blockStart; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        if (!isLevel1Block.test(line)) {
            blockEnd = lineNumber;
            break;
        }
    }

    return lines.slice(blockStart, blockEnd);
}

const varAssignment = /^\s+(\w+)\s*=\s*(.+?)[\s\r\n]*(?:\/\/.+)?[\r\n]*$/;
/**
 * Scans an array of DM code lines and returns an associative array mapping varnames to values. Does not capture variable definitions.
 * @param lines The lines to scan
 * @param blockStart The start of the block to return
 */
export function getDMBlockvars(lines: string[], blockStart: number): { [key: string]: string } {
    let vars: { [key: string]: string } = {};

    let m;
    for (const line of getDMBlock(lines, blockStart)) {
        if ((m = varAssignment.exec(line)) !== null) {
            const varName = m[1];
            const varValue = m[2];
            vars[varName] = varValue;
        }
    }

    return vars;
}

const lineIsDefinition = /^\/?datum\/[\w\/]+\s*(?:\/\/.+)?[\r\n]*$/;
/**
 * Returns whether the supplied code line is a DM datum definition (/datum/test) and not for example a proc
 * @param line 
 */
export function lineIsDatumDefinition(line: string){
    return lineIsDefinition.test(line);
}
