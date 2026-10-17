import { assertOpeningProviderEndpoint, OpeningProviderEndpointError } from "@aistudy/ai";
import { ApiError } from "../auth/service";

/** Server configuration boundary. Actual DNS addresses are checked by transport. */
export function assertProviderEndpointAllowed(baseUrl: string): void {
  try {
    assertOpeningProviderEndpoint(baseUrl);
  } catch (error) {
    if (error instanceof OpeningProviderEndpointError) {
      throw new ApiError("VALIDATION", "接口地址必须使用公网 HTTPS；本机模型仅可在显式开启的开发环境使用。", 422);
    }
    throw error;
  }
}
