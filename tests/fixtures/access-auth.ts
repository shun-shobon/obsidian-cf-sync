import { ApplicationError } from "../../packages/worker/src/domain/errors";

export const TEST_ACCESS_ASSERTION = "test-access-assertion";

export function authenticate(request: Request): Promise<void> {
	if (request.headers.get("Cf-Access-Jwt-Assertion") !== TEST_ACCESS_ASSERTION) {
		return Promise.reject(new ApplicationError("unauthenticated", "Access assertion required"));
	}

	return Promise.resolve();
}
