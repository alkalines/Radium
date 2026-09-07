export type AgentRunnerConfig = {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

export default class AgentRunnerClient {
  private baseUrl: string
  private token: string
  private fetch: typeof globalThis.fetch
  
  constructor(config: AgentRunnerConfig) {
    this.baseUrl = config.baseUrl
    this.token = config.token
    this.fetch = config.fetch ?? globalThis.fetch
  }

  async health(): Promise<unknown> {
    return this.request('/health', {
      method: 'GET'
    })
  }
  
  private async request(url: `/${string}`, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${this.token}`)

    return (await this.fetch(`${this.baseUrl}${url}`, {
      ...init,
      headers
    })).json()
  }
}
