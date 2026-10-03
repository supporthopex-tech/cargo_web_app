import hopexLogo from '../imports/hopex-logo.png'

export function companyLogoUrl(logoPath?: string): string {
  return logoPath?.trim() || hopexLogo
}
