import { RepertoireData } from "./RepertoireData";

export class DataAccessLayer {
    readonly ApiEndpointUri = "https://chess-prod-function.azurewebsites.net/api/user";

    // Keep track of the ETag from the server. If none is returned, it remains undefined.
    private etag?: string;

    constructor(
        private username: string,
        private password: string
    ) {
        if (!this.username || !this.password) {
            throw new Error("No valid user session.");
        }
    }

    public async createAccount(): Promise<void> {
        try {
            const response = await fetch(
                `${this.ApiEndpointUri}/${this.username}`,
                {
                    method: "PUT",
                    headers: {
                        "Authorization": this.password,
                    },
                }
            );

            if (!response.ok) {
                const msg = await response.text();
                throw new Error(`${response.statusText}: ${msg}`);
            }
        } catch (error) {
            console.log("Failed to create account:", error);
            throw error;
        }
    }

    public async deleteAccount(): Promise<void> {
        try {
            const response = await fetch(
                `${this.ApiEndpointUri}/${this.username}`,
                {
                    method: "DELETE",
                    headers: {
                        "Authorization": this.password,
                    },
                }
            );

            if (!response.ok) {
                const msg = await response.text();
                throw new Error(`${response.statusText}: ${msg}`);
            }
        } catch (error) {
            console.log("Failed to delete account:", error);
            throw error;
        }
    }

    public async retrieveRepertoireData(): Promise<RepertoireData> {
        try {

            const response = await fetch(
                `${this.ApiEndpointUri}/${this.username}/variants`,
                {
                    method: "GET",
                    headers: {
                        "Authorization": this.password,
                    },
                }
            );

            if (!response.ok) {
                const msg = await response.text();
                throw new Error(`${response.statusText}: ${msg}`);
            }

            // Store the ETag returned by the server, if present
            const etagHeader = response.headers.get("ETag");
            if (etagHeader) {
                this.etag = etagHeader;
            }

            const remoteData: RepertoireData = await response.json();

            // Re-hydrate any date fields that might have been serialized
            if (remoteData.lastPlayedDate) {
                remoteData.lastPlayedDate = new Date(remoteData.lastPlayedDate);
            }

            return remoteData;
        } catch (error) {
            console.log("Failed to retrieve RepertoireData:", error);
            throw error;
        }
    }

    public async storeRepertoireData(data: RepertoireData): Promise<void> {
        try {
            const response = await fetch(
                `${this.ApiEndpointUri}/${this.username}/variants`,
                {
                    method: "PUT",
                    headers: {
                        "Authorization": this.password,
                        "Content-Type": "application/json",
                        "If-Match": this.etag || "etag-not-found",
                    },
                    body: JSON.stringify(data)
                }
            );

            if (!response.ok) {
                const msg = await response.text();
                throw new Error(`${response.statusText}: ${msg}; If-Match: ${this.etag}`);
            }

            // Update our internal etag if a new one is returned
            const newEtagHeader = response.headers.get("ETag");
            if (newEtagHeader) {
                this.etag = newEtagHeader;
            }
        } catch (error) {
            console.log("Failed to store RepertoireData:", error);
            throw error;
        }
    }
}