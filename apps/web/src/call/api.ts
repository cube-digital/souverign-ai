import type { CallInfo, CallNotes, CallSegment, CallToken } from "@sa/protocol";
import { api } from "../api";

const post = (body?: unknown): RequestInit =>
  body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) };

export const callApi = {
  start: (chatId: string) => api<{ call: CallInfo }>(`/chats/${chatId}/calls`, post()),
  get: (callId: string) => api<CallInfo>(`/calls/${callId}`),
  anchor: (callId: string, messageId: string) =>
    api<{ ok: true }>(`/calls/${callId}/anchor`, post({ message_id: messageId })),
  token: (callId: string) => api<CallToken>(`/calls/${callId}/token`, post()),
  leave: (callId: string) => api<{ ok: true }>(`/calls/${callId}/leave`, post()),
  end: (callId: string) => api<{ ok: true }>(`/calls/${callId}/end`, post()),
  invite: (callId: string, mediaKey?: string) =>
    api<CallInfo>(`/calls/${callId}/notetaker`, post(mediaKey ? { media_key: mediaKey } : {})),
  consent: (callId: string, decision: "accepted" | "declined") =>
    api<CallInfo>(`/calls/${callId}/consent`, post({ decision })),
  stop: (callId: string) => api<CallInfo>(`/calls/${callId}/notetaker/stop`, post()),
  segments: (callId: string) => api<{ segments: CallSegment[] }>(`/calls/${callId}/segments`),
  notes: (callId: string) => api<CallNotes | null>(`/calls/${callId}/notes`),
  republish: (notesId: string) =>
    api<{ approval_id: string }>(`/calls/notes/${notesId}/republish`, post()),
};
