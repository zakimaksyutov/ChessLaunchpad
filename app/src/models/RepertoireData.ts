import { WeightSettings } from "./WeightSettings";
import { FSRSCardData } from "./FSRSCardData";
import { LinkedAccount } from "../services/LinkedAccountsService";

export interface OpeningVariantData {
    pgn: string;
    orientation: 'black' | 'white';
    classifications: string[];
    errorEMA: number;
    numberOfTimesPlayed: number;
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
    currentEpoch: number;
    lastPlayedDate: Date;
    dailyPlayCount: number; // How many times user has played on the current date
    weightSettings?: WeightSettings;
    fsrsCards?: Record<string, FSRSCardData>;
    settings?: AppSettings | null;
    trainingSettings?: AppSettings | null; // legacy, migrated to settings
}
