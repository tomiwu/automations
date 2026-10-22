import type { FetchFn } from "@automations/shared";

/**
 * Literal Jev secret name. Kody replaces this text when the request goes to api.getjevai.com.
 * Do not build this string at runtime.
 */
export const JEV_API_KEY_PLACEHOLDER = "{{secret:JEV_API_KEY}}";

export const JEV_DECISIONS_URL = "https://api.getjevai.com/v1/decisions";

/** Posts one decision request. The bearer value is the literal secret placeholder. */
export async function postDecision(fetchFn: FetchFn, body: unknown): Promise<unknown> {
  const response = await fetchFn(JEV_DECISIONS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${JEV_API_KEY_PLACEHOLDER}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Jev returned ${response.status}.`);
  return response.json();
}
