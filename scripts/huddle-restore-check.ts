import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {sha256,validateBackup} from './huddle-migration/legacy';
import {restoreFeedbackBackup} from './huddle-migration/restore';
const file = process.argv[2];if(!file) throw new Error('Provide a private complete feedback backup file. This creates only a new disposable recovery database.');
const handle = await open(resolve(file),constants.O_RDONLY | constants.O_NOFOLLOW);let bytes:Buffer;
try {const metadata = await handle.stat();if(!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.size > 32*1024*1024 || metadata.mode & 0o077) throw new Error('Use an owned private regular backup file of at most 32 MiB.');bytes = await handle.readFile();if(bytes.length > 32*1024*1024) throw new Error('The backup changed beyond its byte bound.');} finally {await handle.close();}
const source = validateBackup(JSON.parse(bytes.toString('utf8'))), result = await restoreFeedbackBackup(source);
console.log(JSON.stringify({...result,backupSha256:sha256(bytes)}));
