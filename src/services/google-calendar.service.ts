import { google } from 'googleapis';
import { decryptSecret } from '../utils/crypto';

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI!;

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export function createOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

export function getAuthUrl(state?: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',          // force refresh_token on every consent
    ...(state ? { state } : {}),
  });
}

/** Exchange auth code for tokens. Returns the full token object (includes refresh_token). */
export async function exchangeCode(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Build an authenticated OAuth2 client from a stored token. The stored value is
 * encrypted at rest (see utils/crypto); `decryptSecret` transparently handles
 * legacy plaintext rows.
 */
export function buildAuthClient(storedToken: string) {
  const client = createOAuthClient();
  client.setCredentials(JSON.parse(decryptSecret(storedToken)));
  return client;
}

export interface CalendarEventInput {
  turnoId:          string;
  title:            string;
  description?:     string;
  startIso:         string;   // ISO 8601
  endIso:           string;   // ISO 8601
  location?:        string;
  attendeeEmail?:   string;
  meetLink?:        string;
}

/**
 * Create an event on the profesional's primary calendar.
 * Returns the created event's id (stored as googleEventId on Turno).
 */
export async function createCalendarEvent(
  tokenJson: string,
  input: CalendarEventInput,
): Promise<string> {
  const auth = buildAuthClient(tokenJson);
  const calendar = google.calendar({ version: 'v3', auth });

  const event: any = {
    summary: input.title,
    description: input.description,
    start: { dateTime: input.startIso, timeZone: 'America/Argentina/Buenos_Aires' },
    end:   { dateTime: input.endIso,   timeZone: 'America/Argentina/Buenos_Aires' },
    ...(input.location ? { location: input.location } : {}),
    attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup',  minutes: 60 },
        { method: 'email',  minutes: 1440 }, // 24h
      ],
    },
    ...(input.meetLink ? { conferenceData: undefined } : {}),
  };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
    sendUpdates: 'all',       // send invite emails to attendees
  });

  return res.data.id!;
}

/** Update an existing calendar event (e.g. reschedule). */
export async function updateCalendarEvent(
  tokenJson: string,
  googleEventId: string,
  input: Partial<CalendarEventInput>,
): Promise<void> {
  const auth = buildAuthClient(tokenJson);
  const calendar = google.calendar({ version: 'v3', auth });

  const patch: any = {};
  if (input.title)        patch.summary     = input.title;
  if (input.description)  patch.description = input.description;
  if (input.startIso)     patch.start = { dateTime: input.startIso, timeZone: 'America/Argentina/Buenos_Aires' };
  if (input.endIso)       patch.end   = { dateTime: input.endIso,   timeZone: 'America/Argentina/Buenos_Aires' };
  if (input.location)     patch.location    = input.location;

  await calendar.events.patch({
    calendarId: 'primary',
    eventId:    googleEventId,
    requestBody: patch,
    sendUpdates: 'all',
  });
}

/** Delete (cancel) a calendar event. Safe to call even if event doesn't exist. */
export async function deleteCalendarEvent(
  tokenJson: string,
  googleEventId: string,
): Promise<void> {
  const auth = buildAuthClient(tokenJson);
  const calendar = google.calendar({ version: 'v3', auth });

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId:    googleEventId,
      sendUpdates: 'all',
    });
  } catch (err: any) {
    // 404 / 410 = already deleted — ignore
    if (err?.code !== 404 && err?.code !== 410) throw err;
  }
}
