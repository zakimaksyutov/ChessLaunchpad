import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { RepertoireData } from './RepertoireData';
import { WeightSettings } from './WeightSettings';
import './SettingsPage.css';

interface CoefficientValues {
    recency: string;
    frequency: string;
    error: string;
}

const SettingsPage: React.FC = () => {
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [values, setValues] = useState<CoefficientValues>({ recency: '', frequency: '', error: '' });
    const [initialSettings, setInitialSettings] = useState<WeightSettings | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [saving, setSaving] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string>('');

    const navigate = useNavigate();

    const dal: IDataAccessLayer = useMemo(() => {
        const username = localStorage.getItem('username') || '';
        const hashedPassword = localStorage.getItem('hashedPassword') || '';
        return createDataAccessLayer(username, hashedPassword);
    }, []);

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            setErrorMessage('');
            try {
                const data = await dal.retrieveRepertoireData();
                setRepertoireData(data);
                const settings = WeightSettings.from(data.weightSettings);
                setInitialSettings(settings.clone());
                setValues({
                    recency: settings.recencyPower.toString(),
                    frequency: settings.frequencyPower.toString(),
                    error: settings.errorPower.toString()
                });
            } catch (err: any) {
                setErrorMessage(`Failed to load settings: ${err?.message ?? 'Unknown error'}`);
            } finally {
                setLoading(false);
            }
        };

        load();
    }, [dal]);

    const parseCoefficient = (value: string): number | null => {
        const num = Number(value);
        if (!isFinite(num) || num <= 0) {
            return null;
        }
        return num;
    };

    const parsedValues = {
        recency: parseCoefficient(values.recency),
        frequency: parseCoefficient(values.frequency),
        error: parseCoefficient(values.error)
    };

    const hasInvalidInput = Object.values(parsedValues).some(v => v === null);
    const hasChanges =
        !hasInvalidInput &&
        initialSettings !== null &&
        (
            parsedValues.recency !== initialSettings.recencyPower ||
            parsedValues.frequency !== initialSettings.frequencyPower ||
            parsedValues.error !== initialSettings.errorPower
        );

    const handleChange = (field: keyof CoefficientValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
        setValues(prev => ({
            ...prev,
            [field]: event.target.value
        }));
    };

    const handleReset = () => {
        const defaults = WeightSettings.createDefault();
        setValues({
            recency: defaults.recencyPower.toString(),
            frequency: defaults.frequencyPower.toString(),
            error: defaults.errorPower.toString()
        });
        setErrorMessage('');
    };

    const handleCancel = () => {
        navigate(-1);
    };

    const handleSave = async () => {
        if (!repertoireData || hasInvalidInput || saving) {
            return;
        }

        const newSettings = new WeightSettings(
            parsedValues.recency!,
            parsedValues.frequency!,
            parsedValues.error!
        );

        setSaving(true);
        setErrorMessage('');
        try {
            const updatedData: RepertoireData = {
                ...repertoireData,
                weightSettings: newSettings
            };
            await dal.storeRepertoireData(updatedData);
            setInitialSettings(newSettings.clone());
            setRepertoireData(updatedData);
            navigate(-1);
        } catch (err: any) {
            setErrorMessage(`Failed to save settings: ${err?.message ?? 'Unknown error'}`);
        } finally {
            setSaving(false);
        }
    };

    const renderTable = () => (
        <table className="settings-table">
            <thead>
                <tr>
                    <th>Factor</th>
                    <th>Exponent</th>
                    <th>Description</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>newnessFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">+</span>
                        <input type="number" value="2" readOnly />
                    </td>
                    <td>Boosts openings played fewer than seven times.</td>
                </tr>
                <tr>
                    <td>recencyFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">+</span>
                        <input
                            type="number"
                            step="0.1"
                            min="0.01"
                            value={values.recency}
                            onChange={handleChange('recency')}
                        />
                    </td>
                    <td>Rewards lines that have not been solved recently.</td>
                </tr>
                <tr>
                    <td>frequencyFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">-</span>
                        <input
                            type="number"
                            step="0.1"
                            min="0.01"
                            value={values.frequency}
                            onChange={handleChange('frequency')}
                        />
                    </td>
                    <td>Down-weights variants you solve consistently.</td>
                </tr>
                <tr>
                    <td>errorFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">+</span>
                        <input
                            type="number"
                            step="0.1"
                            min="0.01"
                            value={values.error}
                            onChange={handleChange('error')}
                        />
                    </td>
                    <td>Prioritizes lines with recent mistakes.</td>
                </tr>
            </tbody>
        </table>
    );

    return (
        <div className="settings-page">
            <div className="settings-card">
                <h1>Weight Settings</h1>
                <p className="settings-description">
                    Tune how strongly each factor contributes to a variant&apos;s training weight.
                    Enter positive values only; higher numbers amplify that part of the formula.
                </p>

                {errorMessage && <div className="settings-error">{errorMessage}</div>}

                {loading ? (
                    <div>Loading...</div>
                ) : (
                    <>
                        {renderTable()}

                        <div className="settings-actions">
                            <button
                                className="primary"
                                onClick={handleSave}
                                disabled={saving || hasInvalidInput || !hasChanges}
                            >
                                {saving ? 'Saving...' : 'Save'}
                            </button>
                            <button className="secondary" onClick={handleCancel} disabled={saving}>
                                Cancel
                            </button>
                            <button className="link" onClick={handleReset} disabled={saving}>
                                Reset
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default SettingsPage;
