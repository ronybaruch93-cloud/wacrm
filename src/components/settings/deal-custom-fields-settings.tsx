'use client';

import { Shield, SlidersHorizontal } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { CustomFieldsPanel } from '@/components/contacts/custom-fields-manager';
import { SettingsChip } from './settings-chip';

/**
 * Settings → Deal fields card. Manages the account-wide custom deal field
 * catalogue (migration 043 — `custom_fields.entity_type = 'deal'`), the
 * generic per-rubro attributes a pipeline needs (appointment date, size,
 * address, etc). Mirrors {@link CustomFieldsSettings} one to one, just
 * pointed at the 'deal' catalogue instead of 'contact'. Writes are
 * admin-gated by the caller and enforced by `custom_fields` RLS.
 */
export function DealCustomFieldsSettings() {
  const t = useTranslations('Settings.tagsAndFields');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <SlidersHorizontal className="size-4 text-primary" />
          {t('dealFieldsTitle')}
          <SettingsChip variant="admin" className="font-medium">
            <Shield />
            {t('adminRole')}
          </SettingsChip>
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('dealFieldsDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CustomFieldsPanel
          entityType="deal"
          translationNamespace="Pipelines.customFields"
        />
      </CardContent>
    </Card>
  );
}
