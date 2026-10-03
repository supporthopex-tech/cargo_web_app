import hopexLogo from '../imports/hopex-logo.png'

interface BrandLogoProps {
  className?: string
  priority?: boolean
}

export default function BrandLogo({ className = '', priority = false }: BrandLogoProps) {
  return (
    <img
      src={hopexLogo}
      alt="Hopex Express Cargo"
      className={`brand-logo ${className}`}
      decoding="async"
      loading={priority ? 'eager' : 'lazy'}
    />
  )
}
