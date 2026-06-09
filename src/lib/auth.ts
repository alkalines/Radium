import { authClient } from "./auth-client"
import { handler } from "./auth-server"

type GetSessionParams = {
  headers?: Headers
  baseURL?: string | URL
}

const getSessionPath = "/api/auth/get-session"

function getSessionUrl(baseURL?: string | URL) {
  if (baseURL) {
    return new URL(getSessionPath, baseURL).toString()
  }

  if (typeof window !== "undefined") {
    return getSessionPath
  }

  throw new Error("baseURL is required when loading auth sessions on the server")
}

export const auth = {
  api: {
    async getSession(params?: GetSessionParams) {
      if (params?.baseURL) {
        const response = await handler(
          new Request(getSessionUrl(params.baseURL), {
            headers: params.headers
          })
        )

        if (!response.ok) {
          return null
        }

        return response.json()
      }

      const { data } = await authClient.getSession({
        fetchOptions: {
          headers: params?.headers
        }
      } as any)

      return data
    }
  }
}
