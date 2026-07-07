export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | Uint8Array;
    contentType: string;
  }>;
  headers?: Record<string, string>;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}
