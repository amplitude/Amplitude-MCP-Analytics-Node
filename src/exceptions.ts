export class AmplitudeMCPAnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmplitudeMCPAnalyticsError';
  }
}

export class ConfigurationError extends AmplitudeMCPAnalyticsError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
