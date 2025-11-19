export class WeightSettings {
    public static readonly DEFAULT_RECENCY_POWER = 1;
    public static readonly DEFAULT_FREQUENCY_POWER = 2;
    public static readonly DEFAULT_ERROR_POWER = 2;

    public recencyPower: number;
    public frequencyPower: number;
    public errorPower: number;

    constructor(
        recencyPower: number = WeightSettings.DEFAULT_RECENCY_POWER,
        frequencyPower: number = WeightSettings.DEFAULT_FREQUENCY_POWER,
        errorPower: number = WeightSettings.DEFAULT_ERROR_POWER
    ) {
        this.recencyPower = recencyPower;
        this.frequencyPower = frequencyPower;
        this.errorPower = errorPower;
    }

    public static createDefault(): WeightSettings {
        return new WeightSettings(
            WeightSettings.DEFAULT_RECENCY_POWER,
            WeightSettings.DEFAULT_FREQUENCY_POWER,
            WeightSettings.DEFAULT_ERROR_POWER
        );
    }

    public static from(obj?: Partial<WeightSettings> | null): WeightSettings {
        if (!obj) {
            return WeightSettings.createDefault();
        }

        const recency = WeightSettings.sanitizeCoefficient(
            obj.recencyPower,
            WeightSettings.DEFAULT_RECENCY_POWER
        );
        const frequency = WeightSettings.sanitizeCoefficient(
            obj.frequencyPower,
            WeightSettings.DEFAULT_FREQUENCY_POWER
        );
        const error = WeightSettings.sanitizeCoefficient(
            obj.errorPower,
            WeightSettings.DEFAULT_ERROR_POWER
        );

        return new WeightSettings(recency, frequency, error);
    }

    public clone(): WeightSettings {
        return new WeightSettings(this.recencyPower, this.frequencyPower, this.errorPower);
    }

    public reset(): void {
        this.recencyPower = WeightSettings.DEFAULT_RECENCY_POWER;
        this.frequencyPower = WeightSettings.DEFAULT_FREQUENCY_POWER;
        this.errorPower = WeightSettings.DEFAULT_ERROR_POWER;
    }

    private static sanitizeCoefficient(value: any, fallback: number): number {
        const parsed = Number(value);
        if (!isFinite(parsed) || parsed < 0) {
            return fallback;
        }
        return parsed;
    }
}
