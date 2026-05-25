import { FSRSCardData } from "./FSRSCardData";
import { LinkedAccount } from "../services/LinkedAccountsService";

export interface OpeningVariantData {
    pgn: string;
    orientation: 'black' | 'white';
    classifications: string[];
    numberOfTimesPlayed: number;
    // V1 stub fields — always 0, kept because the backend schema requires them.
    errorEMA: number;
    lastSucceededEpoch: number;
    successEMA: number;
}

export interface AppSettings {
    contextDepth?: number;
    retention?: number;
    maxInterval?: number;
    linkedAccounts?: LinkedAccount[];
    [key: string]: unknown; // preserve unknown fields
}

export interface RepertoireData {
    data: OpeningVariantData[];
    // V1 stub — always 0, kept because the backend schema requires it.
    currentEpoch: number;
    lastPlayedDate: Date;
    dailyPlayCount: number; // How many times user has played on the current date
    fsrsCards?: Record<string, FSRSCardData>;
    settings?: AppSettings | null;
    trainingSettings?: AppSettings | null; // legacy, migrated to settings
}
