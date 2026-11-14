import type { LoadedProject, StepImage } from '@shared/types'
import { allImages } from '@shared/types'
import { useMediaUrl } from '../hooks'

interface Props {
  project: LoadedProject
}

/**
 * The last look before anything gets shared.
 *
 * Every screenshot in one place, so the author scans for tenant names,
 * subscription IDs and email addresses once, deliberately - rather than hoping
 * they remembered to blur each one at the time.
 */
export default function Review({ project }: Props): React.JSX.Element {
  const images = allImages(project.steps).map((entry, index) => ({ ...entry, index }))

  return (
    <div className="review">
      <section className="panel">
        <header className="panel-head">
          <h2>Screenshots</h2>
          <p>
            Everything a learner will see, together. Anything that should not be published has to be
            fixed at the source: retake the screenshot with the snip tool&apos;s blur, or delete the
            step.
          </p>
        </header>

        {images.length === 0 ? (
          <p className="muted">No screenshots captured yet.</p>
        ) : (
          <>
            <div className="contact-sheet">
              {images.map(({ image, index }) => (
                <Thumb key={image.id} image={image} index={index} />
              ))}
            </div>
            <p className="field-help">
              {images.length} screenshot{images.length === 1 ? '' : 's'} across{' '}
              {project.steps.length} step{project.steps.length === 1 ? '' : 's'}.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

function Thumb({ image, index }: { image: StepImage; index: number }): React.JSX.Element {
  const url = useMediaUrl(image.file)
  return (
    <figure className="thumb">
      {url ? <img src={url} alt="" /> : <div className="thumb-missing">missing</div>}
      <figcaption>
        <strong>{index + 1}</strong>
        <code>{image.token}</code>
      </figcaption>
    </figure>
  )
}
