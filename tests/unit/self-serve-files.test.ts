// @vitest-environment node
import {describe,it,expect,vi,afterEach} from 'vitest';
import ExcelJS from 'exceljs';
import {extractFile,sealFile,openFile,validateArchive} from '@/lib/self-serve/files';
import {parseWhatsApp,redactSamples} from '@/lib/self-serve/voice';
afterEach(()=>vi.unstubAllEnvs());
describe('self-serve files and review preparation',()=>{
 it('retains quoted CSV row references and Excel sheet/row references',async()=>{
  const csv=await extractFile({name:'policies.csv',type:'text/csv',data:Buffer.from('Policy,Details\nDeposit,"S$10, refundable with 24 hours notice"').toString('base64')});expect(csv).toEqual([{ref:'row 1',text:'Policy | Details'},{ref:'row 2',text:'Deposit | S$10, refundable with 24 hours notice'}]);
  const workbook=new ExcelJS.Workbook();workbook.addWorksheet('Hours').addRow(['Opening hours','10am–10pm']);const bytes=Buffer.from(await workbook.xlsx.writeBuffer());const excel=await extractFile({name:'hours.xlsx',type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',data:bytes.toString('base64')});expect(excel).toEqual([{ref:'Hours, row 1',text:'Opening hours | 10am–10pm'}]);
 });
 it('rejects malformed archives and unsupported or oversized files',async()=>{
  await expect(validateArchive(Buffer.from('not a ZIP'))).rejects.toThrow(/archive/);
  await expect(extractFile({name:'run.exe',type:'binary',data:'dGVzdA=='})).rejects.toThrow(/Unsupported/);
  await expect(extractFile({name:'empty.txt',type:'text/plain',data:''})).rejects.toThrow(/nonempty/);
 });
 it('encrypts temporary uploads and separates business samples before redaction',()=>{
  vi.stubEnv('PRONTO_SECRETS_KEY','fixture-secret-encryption-key-more-than-32-characters');const file={name:'chat.txt',type:'text/plain',data:'c2FtcGxl'};const sealed=sealFile(file);expect(JSON.stringify(sealed)).not.toContain(file.data);expect(openFile(sealed)).toEqual(file);
  const messages=parseWhatsApp('[20/11/26, 10:00 AM] Customer: Hello\n20/11/26, 10:01 AM - Business: hey! email us at hello@example.com\n+6591234567');expect(messages.map(m=>m.speaker)).toEqual(['Customer','Business']);expect(redactSamples(messages[1].body,messages.map(m=>m.speaker))).not.toMatch(/hello@example|91234567/);
 });
});
