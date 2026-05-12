interface WildcardOriginRule {
  protocol: 'http:' | 'https:' | null;
  hostnameSuffix: string;
  port: string | null;
  description: string;
}

export interface CorsOriginRules {
  exactOrigins: Set<string>;
  wildcardOrigins: WildcardOriginRule[];
  allowedOriginDescriptions: string[];
}

const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'];
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const normalizeOriginToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const unquoted = trimmed.replace(/^(['"])(.*)\1$/, '$2');
  const withoutTrailingSlash = unquoted.replace(/\/+$/, '');
  return withoutTrailingSlash || null;
};

export const normalizeOrigin = (value: string): string | null => {
  const token = normalizeOriginToken(value);
  if (!token) return null;

  try {
    const url = new URL(token);
    return url.origin;
  } catch {
    return null;
  }
};

export const isLoopbackHostname = (hostname: string): boolean => (
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
);

const parseWildcardOrigin = (value: string): WildcardOriginRule | null => {
  const token = normalizeOriginToken(value);
  if (!token) return null;

  const withProtocol = token.match(/^(https?):\/\/\*\.(.+)$/i);
  const withoutProtocol = token.match(/^\*\.(.+)$/i);

  let protocol: 'http:' | 'https:' | null = null;
  let hostAndPort: string | null = null;

  if (withProtocol) {
    protocol = `${withProtocol[1].toLowerCase()}:` as 'http:' | 'https:';
    hostAndPort = withProtocol[2];
  } else if (withoutProtocol) {
    hostAndPort = withoutProtocol[1];
  }

  if (!hostAndPort) return null;

  try {
    const parsed = new URL(`http://${hostAndPort}`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }

    const hostnameSuffix = parsed.hostname.toLowerCase();
    if (!hostnameSuffix || isLoopbackHostname(hostnameSuffix)) {
      return null;
    }

    const port = parsed.port || null;
    const description = `${protocol ? `${protocol}//` : ''}*.${hostnameSuffix}${port ? `:${port}` : ''}`;

    return {
      protocol,
      hostnameSuffix,
      port,
      description,
    };
  } catch {
    return null;
  }
};

const splitOriginTokens = (rawValues: string[]): string[] => (
  rawValues
    .flatMap((value) => value.split(/[\s,;]+/))
    .map((value) => normalizeOriginToken(value))
    .filter((value): value is string => Boolean(value))
);

export const createCorsOriginRules = ({
  frontendUrls,
  frontendUrl,
  isProduction,
}: {
  frontendUrls?: string;
  frontendUrl?: string;
  isProduction: boolean;
}): CorsOriginRules => {
  const rawValues = [frontendUrls, frontendUrl].filter((value): value is string => Boolean(value?.trim()));
  if (rawValues.length === 0) {
    rawValues.push('http://localhost:3000');
  }

  const exactOrigins = new Set<string>();
  const wildcardOriginsMap = new Map<string, WildcardOriginRule>();

  for (const token of splitOriginTokens(rawValues)) {
    const wildcard = parseWildcardOrigin(token);
    if (wildcard) {
      wildcardOriginsMap.set(wildcard.description, wildcard);
      continue;
    }

    const normalized = normalizeOrigin(token);
    if (normalized) {
      exactOrigins.add(normalized);
    }
  }

  if (!isProduction) {
    for (const devOrigin of DEV_ORIGINS) {
      exactOrigins.add(devOrigin);
    }
  }

  const wildcardOrigins = Array.from(wildcardOriginsMap.values());
  const allowedOriginDescriptions = [...Array.from(exactOrigins), ...wildcardOrigins.map((rule) => rule.description)];

  return {
    exactOrigins,
    wildcardOrigins,
    allowedOriginDescriptions,
  };
};

const matchesWildcardOrigin = (url: URL, rule: WildcardOriginRule): boolean => {
  if (rule.protocol && url.protocol !== rule.protocol) {
    return false;
  }

  if (rule.port && url.port !== rule.port) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return hostname.endsWith(`.${rule.hostnameSuffix}`);
};

export const isOriginAllowed = (
  origin: string,
  rules: CorsOriginRules,
  isProduction: boolean,
): boolean => {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  if (rules.exactOrigins.has(normalizedOrigin)) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(normalizedOrigin);
  } catch {
    return false;
  }

  if (rules.wildcardOrigins.some((rule) => matchesWildcardOrigin(url, rule))) {
    return true;
  }

  if (!isProduction && isLoopbackHostname(url.hostname)) {
    return true;
  }

  return false;
};
