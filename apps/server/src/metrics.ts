export class MetricsRegistry {
  private readonly counters = new Map<string, number>();

  increment(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  renderPrometheus(): string {
    const lines: string[] = [
      "# HELP dezhou_hands_started_total Number of hands started.",
      "# TYPE dezhou_hands_started_total counter",
      `dezhou_hands_started_total ${this.counters.get("hands_started_total") ?? 0}`,
      "# HELP dezhou_hands_finished_total Number of hands finished.",
      "# TYPE dezhou_hands_finished_total counter",
      `dezhou_hands_finished_total ${this.counters.get("hands_finished_total") ?? 0}`,
      "# HELP dezhou_timeouts_auto_total Number of timeout auto actions.",
      "# TYPE dezhou_timeouts_auto_total counter",
      `dezhou_timeouts_auto_total ${this.counters.get("timeouts_auto_total") ?? 0}`,
      "# HELP dezhou_disconnect_total Number of disconnects.",
      "# TYPE dezhou_disconnect_total counter",
      `dezhou_disconnect_total ${this.counters.get("disconnect_total") ?? 0}`,
      "# HELP dezhou_reconnect_total Number of reconnects.",
      "# TYPE dezhou_reconnect_total counter",
      `dezhou_reconnect_total ${this.counters.get("reconnect_total") ?? 0}`,
      "# HELP dezhou_errors_total Number of server errors.",
      "# TYPE dezhou_errors_total counter",
      `dezhou_errors_total ${this.counters.get("errors_total") ?? 0}`
    ];
    return `${lines.join("\n")}\n`;
  }
}
