/**
 * Gmail Service — search, read, send, and reply to emails.
 *
 * Executes in the Gateway process (not in executor containers) because
 * it needs OAuth tokens, which must never be passed to containers.
 *
 * Uses the Google Gmail API via googleapis.
 *
 * Action classification:
 * - search_email, read_email → auto-approve
 * - send_email, reply_email → ALWAYS require-approval
 */

import { google, type gmail_v1 } from 'googleapis';
import type { OAuthStore } from './oauth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labels: string[];
}

export interface EmailFull {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  date: string;
  body: string;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Gmail Service
// ---------------------------------------------------------------------------

export class GmailService {
  private oauthStore: OAuthStore;

  constructor(oauthStore: OAuthStore) {
    this.oauthStore = oauthStore;
  }

  /**
   * Check if Gmail is connected (has stored token).
   */
  isConnected(): boolean {
    return this.oauthStore.hasToken('gmail');
  }

  /**
   * Get an authenticated Gmail client.
   */
  private getClient(): gmail_v1.Gmail {
    const tokenData = this.oauthStore.getToken('gmail');
    if (!tokenData) {
      throw new Error('Gmail not connected. Use /connect gmail to set up.');
    }

    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({
      access_token: tokenData.accessToken,
      refresh_token: tokenData.refreshToken,
      token_type: tokenData.tokenType,
    });

    // Handle token refresh
    oauth2Client.on('tokens', (tokens) => {
      if (tokens.access_token) {
        this.oauthStore.storeToken('gmail', {
          ...tokenData,
          accessToken: tokens.access_token,
          expiresAt: tokens.expiry_date || Date.now() + 3600000,
        });
        console.log('[gmail] Token refreshed');
      }
    });

    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  /**
   * Search emails by query string (Gmail search syntax).
   * Returns a list of email summaries.
   */
  async search(query: string, maxResults: number = 10): Promise<string> {
    const gmail = this.getClient();

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = response.data.messages || [];
    if (messages.length === 0) {
      return 'No emails found matching your query.';
    }

    const summaries: EmailSummary[] = [];
    for (const msg of messages) {
      if (!msg.id) continue;
      try {
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Date'],
        });

        const headers = full.data.payload?.headers || [];
        summaries.push({
          id: msg.id,
          threadId: msg.threadId || '',
          subject: getHeader(headers, 'Subject') || '(no subject)',
          from: getHeader(headers, 'From') || 'unknown',
          to: getHeader(headers, 'To') || 'unknown',
          date: getHeader(headers, 'Date') || 'unknown',
          snippet: full.data.snippet || '',
          labels: full.data.labelIds || [],
        });
      } catch (err) {
        console.error(`[gmail] Failed to fetch message ${msg.id}:`, err);
      }
    }

    return summaries
      .map(
        (s) =>
          `📧 **${s.subject}**\n   From: ${s.from}\n   Date: ${s.date}\n   ${s.snippet}\n   ID: ${s.id}`,
      )
      .join('\n\n');
  }

  /**
   * Read the full content of a specific email.
   */
  async read(messageId: string): Promise<string> {
    const gmail = this.getClient();

    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = response.data.payload?.headers || [];
    const body = extractBody(response.data.payload);

    const email: EmailFull = {
      id: messageId,
      threadId: response.data.threadId || '',
      subject: getHeader(headers, 'Subject') || '(no subject)',
      from: getHeader(headers, 'From') || 'unknown',
      to: getHeader(headers, 'To') || 'unknown',
      cc: getHeader(headers, 'Cc'),
      date: getHeader(headers, 'Date') || 'unknown',
      body: body || '(empty body)',
      labels: response.data.labelIds || [],
    };

    let result = `📧 **${email.subject}**\n`;
    result += `From: ${email.from}\n`;
    result += `To: ${email.to}\n`;
    if (email.cc) result += `CC: ${email.cc}\n`;
    result += `Date: ${email.date}\n`;
    result += `Thread: ${email.threadId}\n\n`;
    result += email.body;

    return result;
  }

  /**
   * Send a new email.
   * ALWAYS requires approval.
   */
  async send(to: string, subject: string, body: string): Promise<string> {
    const gmail = this.getClient();

    const rawMessage = createRawMessage(to, subject, body);

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: rawMessage,
      },
    });

    return `✅ Email sent successfully.\nMessage ID: ${response.data.id}\nTo: ${to}\nSubject: ${subject}`;
  }

  /**
   * Reply to an existing email.
   * ALWAYS requires approval.
   */
  async reply(messageId: string, body: string): Promise<string> {
    const gmail = this.getClient();

    // Get the original message for headers
    const original = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Message-ID'],
    });

    const headers = original.data.payload?.headers || [];
    const originalFrom = getHeader(headers, 'From') || '';
    const originalSubject = getHeader(headers, 'Subject') || '';
    const messageIdHeader = getHeader(headers, 'Message-ID') || '';

    const subject = originalSubject.startsWith('Re:')
      ? originalSubject
      : `Re: ${originalSubject}`;

    const rawMessage = createRawReply(
      originalFrom,
      subject,
      body,
      messageIdHeader,
      original.data.threadId || '',
    );

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: rawMessage,
        threadId: original.data.threadId || undefined,
      },
    });

    return `✅ Reply sent successfully.\nMessage ID: ${response.data.id}\nTo: ${originalFrom}\nSubject: ${subject}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string | undefined {
  const header = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return header?.value ?? undefined;
}

function extractBody(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return '';

  // Check for simple body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Check multipart
  if (payload.parts) {
    // Prefer text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    // Fall back to text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64url').toString('utf-8');
        // Simple HTML stripping
        return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      }
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return '';
}

function createRawMessage(to: string, subject: string, body: string): string {
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  return Buffer.from(message).toString('base64url');
}

function createRawReply(
  to: string,
  subject: string,
  body: string,
  inReplyTo: string,
  _threadId: string,
): string {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ];

  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  const message = [...headers, '', body].join('\r\n');
  return Buffer.from(message).toString('base64url');
}
