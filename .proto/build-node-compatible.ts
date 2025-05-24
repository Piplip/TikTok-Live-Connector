// Essentially, the merging of 3 files is too complicated for the type system, so instead
// We merge all the proto files BEFORE compiling


import * as fs from 'node:fs';
import { execSync } from 'child_process';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, './src');
const TMP_DIR = path.resolve(__dirname, './tmp');

const HEADER = `syntax = "proto3";
package TikTok;

`;

function getProtoFiles(dir: string): string[] {
    const files: string[] = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(...getProtoFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.proto')) {
            files.push(fullPath);
        }
    }

    return files;
}

function stripUnwantedLines(content: string): string {
    return content
        .split('\n')
        .filter(line => !/^\s*(syntax|import|package)\b/.test(line))
        .join('\n')
        .trim();
}

function mergeProtoFiles() {
    const protoFiles = getProtoFiles(SRC_DIR);
    let mergedContent = '';

    for (const file of protoFiles) {
        const content = fs.readFileSync(file, 'utf8');
        const cleaned = stripUnwantedLines(content);
        mergedContent += '\n\n' + cleaned;
    }

    const finalContent = HEADER + mergedContent + '\n';
    const outputFile = path.resolve(TMP_DIR, 'tiktok-schema.proto');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, finalContent, 'utf8');
    console.log(`Merged .proto files into ${outputFile}`);
}

mergeProtoFiles();

console.log('Building Protobuf TypeScript API for TikTok-Live-Connector');

const OUT_DIR = path.resolve(__dirname, '../src/types');

try {
    const protocGenTsPath = execSync('npx which protoc-gen-ts_proto').toString().trim();

    const command = [
        'protoc',
        `--plugin=protoc-gen-ts_proto=${protocGenTsPath}`,
        `--ts_proto_out=${OUT_DIR}`,
        '--ts_proto_opt=forceLong=string',
        '--ts_proto_opt=outputPartialMethods=false',
        '--ts_proto_opt=snakeToCamel=true',
        '--ts_proto_opt=outputJsonMethods=false',
        '--ts_proto_opt=esModuleInterop=true',
        `-I=${TMP_DIR}`,
        `${TMP_DIR}/*.proto`
    ].join(' ');

    execSync(command, { stdio: 'inherit' });
    console.log('Protobuf TypeScript API build completed.');
} catch (error) {
    console.error('Failed to build Protobuf TypeScript API:', error);
}

