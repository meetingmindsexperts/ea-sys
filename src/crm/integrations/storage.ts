/**
 * THE CRM'S FILE STORAGE PORT (Nov 6, 2026; CRM product review P1-8).
 *
 * The CRM keeps two kinds of private file: deal documents (uploads and quote
 * PDFs) and the attachments of inbound email. Every CRM service and route
 * reaches storage through this interface, never @/lib/storage directly, so a
 * CRM deployed on its own can hand in a different store without its business
 * logic changing. The default implementation below is EA-SYS's own storage
 * (local, Supabase or S3, whatever STORAGE_PROVIDER says), with the private
 * upload prefixes it already used: nothing about where files live changed.
 */
import { deleteStoredFile, readStoredFile, uploadFile } from "@/lib/storage";
import { UPLOAD_PREFIX, UPLOAD_SEGMENT } from "@/lib/upload-prefixes";

export type CrmFileKind = "dealDocument" | "emailAttachment";

export interface CrmDocumentStorage {
  /** Store a file under its owner (a deal id, a thread id); returns the stored path. */
  save(kind: CrmFileKind, ownerId: string, file: { buffer: Buffer; filename: string; mimeType: string }): Promise<string>;
  /** Read a stored file of that kind; refuses a path outside the kind's private prefix. Throws StorageError. */
  read(kind: CrmFileKind, storedPath: string): Promise<Buffer>;
  /** Remove a stored file of that kind; refuses a path outside the kind's private prefix. */
  remove(kind: CrmFileKind, storedPath: string): Promise<void>;
}

const SEGMENT: Record<CrmFileKind, string> = {
  dealDocument: UPLOAD_SEGMENT.crmDealDocs,
  emailAttachment: UPLOAD_SEGMENT.crmEmailAttachments,
};
const PREFIX: Record<CrmFileKind, string> = {
  dealDocument: UPLOAD_PREFIX.crmDealDocs,
  emailAttachment: UPLOAD_PREFIX.crmEmailAttachments,
};

/** EA-SYS's storage, behind the CRM's port. */
export const crmStorage: CrmDocumentStorage = {
  save: (kind, ownerId, file) => uploadFile(file.buffer, file.filename, file.mimeType, `${SEGMENT[kind]}/${ownerId}`),
  read: (kind, storedPath) => readStoredFile(storedPath, PREFIX[kind]),
  remove: (kind, storedPath) => deleteStoredFile(storedPath, PREFIX[kind]),
};
