import { fetch } from "bun"

type AgentRunnerConfig = {
  baseUrl: `http://${string}` | `https://${string}`
  token: string
}

export default class AgentRunnerClient {
  private baseUrl: string
  private token: string
  
  constructor(config: AgentRunnerConfig) {
    this.baseUrl = config.baseUrl
    this.token = config.token
  }

  async health() {
    this.fetch('/health', {
      method: 'GET'
    })
  }
  
  private async fetch(url: `/${string}`, init?: BunFetchRequestInit): Promise<any> {
    if (!init) init = {}
    if (!init.headers) init.headers = {}

    // Authentication
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${this.token}`)
    init.headers = headers
    
    return (await fetch(`${this.baseUrl}${url}`, init)).json()
  }
}
