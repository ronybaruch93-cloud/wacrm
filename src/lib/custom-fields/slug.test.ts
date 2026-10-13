import { describe, expect, it } from 'vitest';

import { slugifyKey } from './slug';

describe('slugifyKey', () => {
  it('lower-cases and joins words with underscores', () => {
    expect(slugifyKey('Fecha Retiro')).toBe('fecha_retiro');
  });

  it('strips accents', () => {
    expect(slugifyKey('Fecha límite')).toBe('fecha_limite');
    expect(slugifyKey('Dirección de envío')).toBe('direccion_de_envio');
  });

  it('collapses punctuation and repeated separators', () => {
    expect(slugifyKey('  Talle -- (M/L)  ')).toBe('talle_m_l');
  });

  it('leaves an already-normalised key unchanged', () => {
    expect(slugifyKey('codigo_postal')).toBe('codigo_postal');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(slugifyKey('¡¿?!')).toBe('');
  });
});
