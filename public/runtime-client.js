export class RuntimeClient {
  constructor({ baseUrl = "", clientId = crypto.randomUUID() } = {}) {
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.revision = null;
    this.instanceId = null;
    this.eventSource = null;
  }

  async load() {
    return this.#accept(await this.#request("/api/project"));
  }

  async applyOperations(operations, expectedRevision = this.revision) {
    return this.#accept(await this.#request("/api/operations", {
      method: "POST",
      body: { operations, expectedRevision, sourceId: this.clientId },
    }));
  }

  async replaceProject(project, expectedRevision = this.revision) {
    return this.#accept(await this.#request("/api/project", {
      method: "PUT",
      body: { project, expectedRevision, sourceId: this.clientId },
    }));
  }

  async newProject(title = "Untitled", expectedRevision = this.revision) {
    return this.#accept(await this.#request("/api/project/new", {
      method: "POST",
      body: { title, expectedRevision, sourceId: this.clientId },
    }));
  }

  async setTitle(title, expectedRevision = this.revision) {
    return this.#accept(await this.#request("/api/project/title", {
      method: "PATCH",
      body: { title, expectedRevision, sourceId: this.clientId },
    }));
  }

  async focusNode(id) {
    return this.#request("/api/focus", {
      method: "POST",
      body: { id, sourceId: this.clientId },
    });
  }

  subscribe(onEvent, onError = console.error) {
    this.close();
    const source = new EventSource(`${this.baseUrl}/api/events`);
    source.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse(event.data);
      this.#accept(snapshot);
      onEvent({ type: "snapshot", ...snapshot });
    });
    source.addEventListener("runtime", (event) => {
      const runtimeEvent = JSON.parse(event.data);
      if (runtimeEvent.instanceId && runtimeEvent.instanceId !== this.instanceId) {
        this.instanceId = runtimeEvent.instanceId;
        this.revision = runtimeEvent.revision ?? null;
      } else if (runtimeEvent.revision !== undefined) {
        this.revision = Math.max(this.revision ?? 0, runtimeEvent.revision);
      }
      onEvent(runtimeEvent);
    });
    source.onerror = onError;
    this.eventSource = source;
    return () => this.close();
  }

  close() {
    this.eventSource?.close();
    this.eventSource = null;
  }

  #accept(snapshot) {
    if (snapshot?.instanceId) this.instanceId = snapshot.instanceId;
    if (snapshot?.revision !== undefined) this.revision = snapshot.revision;
    return snapshot;
  }

  async #request(path, { method = "GET", body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.code = data.code;
      error.currentRevision = data.currentRevision;
      throw error;
    }
    return data;
  }
}
