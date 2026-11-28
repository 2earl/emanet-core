/**
 * Telling staff something happened that they should be able to notice (docs/DESIGN.md §14): a
 * sealed archive record or file was opened. The opening is already in the audit log; this makes
 * sure someone looks. Sending never fails what it reports.
 */
import { archiveOpenedMail, type Send } from './mail';

export async function archiveOpenedNotice(
  send: Send,
  to: string,
  merkez: string,
  what: { kind: 'record' | 'file'; staffId: string; archiveId: string; at: number },
): Promise<boolean> {
  try {
    return await send(archiveOpenedMail(to, what, `${merkez}/privacy/archive/${what.archiveId}`));
  } catch {
    return false;
  }
}
