import { authClient } from "./auth-client"

export const auth = {
  api: {
    async getSession(params?: { headers?: Headers }) {
      const { data } = await authClient.getSession({
        fetchOptions: {
          headers: params?.headers
        }
      } as any)

      return data
    }
  }
}
