import React from 'react';

import {
    Alert,
    Box,
    Button,
    CircularProgress,
    FormControlLabel,
    IconButton,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';

import { I18n } from '@iobroker/adapter-react-v5';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

interface SshRule {
    host: string;
    ports: string;
}

interface SshSettingsState extends ConfigGenericState {
    /** null while the first probe result has not arrived yet */
    available: boolean | null;
}

/**
 * Custom admin component for the remote shell (SSH) settings.
 *
 * It reads the adapter's `info.sshAvailable` state (written on start by a probe of `127.0.0.1:22`) and
 * subscribes to it. When no SSH server is reachable, or the account is not pro, it shows a hint and hides
 * the inputs entirely - so the settings only appear when enabling them can actually do something. When a
 * server is present it renders the enable switch and the host/port allow-list itself, reading and writing
 * `sshEnabled` and `sshRules` in the form data.
 */
export default class SshSettings extends ConfigGeneric<ConfigGenericProps, SshSettingsState> {
    private oid = '';

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            available: null,
        };
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        const { adapterName, instance } = this.props.oContext;
        this.oid = `${adapterName}.${instance}.info.sshAvailable`;
        try {
            const state = await this.props.oContext.socket.getState(this.oid);
            this.setState({ available: !!state?.val });
        } catch {
            this.setState({ available: false });
        }
        try {
            await this.props.oContext.socket.subscribeState(this.oid, this.onSshStateChanged);
        } catch {
            // subscription is a live-update nicety; the value read above is enough
        }
    }

    componentWillUnmount(): void {
        if (this.oid) {
            this.props.oContext.socket.unsubscribeState(this.oid, this.onSshStateChanged);
        }
        super.componentWillUnmount();
    }

    onSshStateChanged = (id: string, state: ioBroker.State | null | undefined): void => {
        if (id === this.oid) {
            this.setState({ available: !!state?.val });
        }
    };

    /** Whether the account can use remote access at all (pro only), from the current form data. */
    private isPro(): boolean {
        const data = this.props.data;
        if (data.useCredentials) {
            return data.server === 'iobroker.pro';
        }
        return typeof data.apikey === 'string' && data.apikey.startsWith('@pro_');
    }

    private getRules(): SshRule[] {
        const rules = ConfigGeneric.getValue(this.props.data, 'sshRules');
        return Array.isArray(rules) ? (rules as SshRule[]) : [];
    }

    private setRules(rules: SshRule[]): void {
        void this.onChange('sshRules', rules);
    }

    private renderRules(): React.JSX.Element {
        const rules = this.getRules();
        return (
            <Box sx={{ mt: 2 }}>
                <Typography
                    variant="subtitle2"
                    gutterBottom
                >
                    {I18n.t('ssh_allowed')}
                </Typography>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell sx={{ width: '55%' }}>{I18n.t('ssh_host')}</TableCell>
                            <TableCell sx={{ width: '35%' }}>{I18n.t('ssh_ports')}</TableCell>
                            <TableCell sx={{ width: '10%' }} />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rules.map((rule, index) => (
                            <TableRow key={index}>
                                <TableCell>
                                    <TextField
                                        variant="standard"
                                        fullWidth
                                        value={rule.host || ''}
                                        placeholder={I18n.t('ssh_host_ph')}
                                        onChange={e => {
                                            const next = [...rules];
                                            next[index] = { ...next[index], host: e.target.value };
                                            this.setRules(next);
                                        }}
                                    />
                                </TableCell>
                                <TableCell>
                                    <TextField
                                        variant="standard"
                                        fullWidth
                                        value={rule.ports || ''}
                                        placeholder={I18n.t('ssh_ports_ph')}
                                        onChange={e => {
                                            const next = [...rules];
                                            next[index] = { ...next[index], ports: e.target.value };
                                            this.setRules(next);
                                        }}
                                    />
                                </TableCell>
                                <TableCell>
                                    <Tooltip title={I18n.t('ssh_delete')}>
                                        <IconButton
                                            size="small"
                                            onClick={() => this.setRules(rules.filter((_, i) => i !== index))}
                                        >
                                            <DeleteIcon fontSize="small" />
                                        </IconButton>
                                    </Tooltip>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                <Button
                    startIcon={<AddIcon />}
                    onClick={() => this.setRules([...rules, { host: '', ports: '' }])}
                    sx={{ mt: 1 }}
                >
                    {I18n.t('ssh_add')}
                </Button>
                <Typography
                    variant="caption"
                    display="block"
                    sx={{ mt: 1, opacity: 0.7 }}
                >
                    {I18n.t('ssh_note')}
                </Typography>
            </Box>
        );
    }

    renderItem(): React.JSX.Element {
        const { available } = this.state;

        if (available === null) {
            return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={18} />
                    <Typography variant="body2">{I18n.t('ssh_checking')}</Typography>
                </Box>
            );
        }

        if (!this.isPro()) {
            return <Alert severity="info">{I18n.t('ssh_only_pro')}</Alert>;
        }

        if (!available) {
            // No SSH server on this machine: show why and hide the settings entirely.
            return (
                <Box>
                    <Alert severity="warning">{I18n.t('ssh_not_available')}</Alert>
                    <Typography
                        variant="body2"
                        sx={{ mt: 1 }}
                    >
                        {I18n.t('ssh_hint_install')}
                    </Typography>
                </Box>
            );
        }

        const enabled = !!ConfigGeneric.getValue(this.props.data, 'sshEnabled');

        return (
            <Box>
                <Alert severity="success">{I18n.t('ssh_available')}</Alert>
                <FormControlLabel
                    sx={{ mt: 1 }}
                    control={
                        <Switch
                            checked={enabled}
                            onChange={e => this.onChange('sshEnabled', e.target.checked)}
                        />
                    }
                    label={I18n.t('ssh_enable')}
                />
                {enabled ? this.renderRules() : null}
            </Box>
        );
    }
}
