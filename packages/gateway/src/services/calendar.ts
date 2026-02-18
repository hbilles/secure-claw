/**
 * Google Calendar Service — list, create, and update calendar events.
 *
 * Executes in the Gateway process (not in executor containers) because
 * it needs OAuth tokens, which must never be passed to containers.
 *
 * Uses the Google Calendar API via googleapis.
 *
 * Action classification:
 * - list_events → auto-approve
 * - create_event, update_event → require-approval
 */

import { google, type calendar_v3 } from 'googleapis';
import type { OAuthStore } from './oauth.js';

// ---------------------------------------------------------------------------
// Calendar Service
// ---------------------------------------------------------------------------

export class CalendarService {
  private oauthStore: OAuthStore;

  constructor(oauthStore: OAuthStore) {
    this.oauthStore = oauthStore;
  }

  /**
   * Check if Calendar is connected (has stored token).
   */
  isConnected(): boolean {
    return this.oauthStore.hasToken('calendar');
  }

  /**
   * Get an authenticated Calendar client.
   */
  private getClient(): calendar_v3.Calendar {
    const tokenData = this.oauthStore.getToken('calendar');
    if (!tokenData) {
      throw new Error('Google Calendar not connected. Use /connect calendar to set up.');
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
        this.oauthStore.storeToken('calendar', {
          ...tokenData,
          accessToken: tokens.access_token,
          expiresAt: tokens.expiry_date || Date.now() + 3600000,
        });
        console.log('[calendar] Token refreshed');
      }
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  /**
   * List events in a time range.
   */
  async listEvents(timeMin: string, timeMax: string): Promise<string> {
    const calendar = this.getClient();

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const events = response.data.items || [];
    if (events.length === 0) {
      return 'No events found in the specified time range.';
    }

    return events
      .map((event) => {
        const start = event.start?.dateTime || event.start?.date || 'unknown';
        const end = event.end?.dateTime || event.end?.date || '';
        const attendees = (event.attendees || [])
          .map((a) => a.email)
          .join(', ');

        let result = `📅 **${event.summary || '(no title)'}**\n`;
        result += `   Start: ${formatDateTime(start)}\n`;
        if (end) result += `   End: ${formatDateTime(end)}\n`;
        if (event.location) result += `   Location: ${event.location}\n`;
        if (attendees) result += `   Attendees: ${attendees}\n`;
        if (event.description) {
          const desc =
            event.description.length > 200
              ? event.description.slice(0, 200) + '…'
              : event.description;
          result += `   Description: ${desc}\n`;
        }
        result += `   ID: ${event.id}`;
        return result;
      })
      .join('\n\n');
  }

  /**
   * Create a new calendar event.
   * Requires approval.
   */
  async createEvent(
    summary: string,
    start: string,
    end: string,
    attendees?: string[],
    description?: string,
    location?: string,
  ): Promise<string> {
    const calendar = this.getClient();

    const eventBody: calendar_v3.Schema$Event = {
      summary,
      start: { dateTime: start },
      end: { dateTime: end },
    };

    if (attendees && attendees.length > 0) {
      eventBody.attendees = attendees.map((email) => ({ email }));
    }
    if (description) eventBody.description = description;
    if (location) eventBody.location = location;

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: eventBody,
      sendUpdates: attendees?.length ? 'all' : 'none',
    });

    return (
      `✅ Event created successfully.\n` +
      `Title: ${response.data.summary}\n` +
      `Start: ${formatDateTime(response.data.start?.dateTime || response.data.start?.date || '')}\n` +
      `End: ${formatDateTime(response.data.end?.dateTime || response.data.end?.date || '')}\n` +
      `ID: ${response.data.id}\n` +
      `Link: ${response.data.htmlLink}`
    );
  }

  /**
   * Update an existing calendar event.
   * Requires approval.
   */
  async updateEvent(
    eventId: string,
    changes: {
      summary?: string;
      start?: string;
      end?: string;
      attendees?: string[];
      description?: string;
      location?: string;
    },
  ): Promise<string> {
    const calendar = this.getClient();

    // Get the current event first
    const current = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const eventBody: calendar_v3.Schema$Event = {
      ...current.data,
    };

    if (changes.summary !== undefined) eventBody.summary = changes.summary;
    if (changes.start !== undefined) eventBody.start = { dateTime: changes.start };
    if (changes.end !== undefined) eventBody.end = { dateTime: changes.end };
    if (changes.description !== undefined) eventBody.description = changes.description;
    if (changes.location !== undefined) eventBody.location = changes.location;
    if (changes.attendees !== undefined) {
      eventBody.attendees = changes.attendees.map((email) => ({ email }));
    }

    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId,
      requestBody: eventBody,
      sendUpdates: changes.attendees ? 'all' : 'none',
    });

    return (
      `✅ Event updated successfully.\n` +
      `Title: ${response.data.summary}\n` +
      `ID: ${response.data.id}\n` +
      `Link: ${response.data.htmlLink}`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(isoString: string): string {
  if (!isoString) return 'unknown';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return isoString;
  }
}
