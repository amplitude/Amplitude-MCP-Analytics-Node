export interface AmplitudeEvent {
  event_type: string;
  user_id?: string;
  device_id?: string;
  event_properties?: Record<string, unknown>;
  user_properties?: Record<string, unknown>;
  groups?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AmplitudeClientLike {
  track: (event: AmplitudeEvent) => void;
  flush: () => unknown;
  shutdown?: () => void;
  configuration?: Record<string, unknown>;
}
