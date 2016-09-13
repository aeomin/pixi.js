let core = require('../core');

/**
 * The ParticleContainer class is a really fast version of the Container built solely for speed,
 * so use when you need a lot of sprites or particles. The tradeoff of the ParticleContainer is that advanced
 * functionality will not work. ParticleContainer implements only the basic object transform (position, scale, rotation).
 * Any other functionality like tinting, masking, etc will not work on sprites in this batch.
 *
 * It's extremely easy to use :
 *
 * ```js
 * let container = new ParticleContainer();
 *
 * for (let i = 0; i < 100; ++i)
 * {
 *     let sprite = new PIXI.Sprite.fromImage("myImage.png");
 *     container.addChild(sprite);
 * }
 * ```
 *
 * And here you have a hundred sprites that will be renderer at the speed of light.
 *
 * @class
 * @extends PIXI.Container
 * @memberof PIXI.particles
 * @param [maxSize=15000] {number} The maximum number of particles that can be renderer by the container.
 * @param [properties] {object} The properties of children that should be uploaded to the gpu and applied.
 * @param [properties.scale=false] {boolean} When true, scale be uploaded and applied.
 * @param [properties.position=true] {boolean} When true, position be uploaded and applied.
 * @param [properties.rotation=false] {boolean} When true, rotation be uploaded and applied.
 * @param [properties.uvs=false] {boolean} When true, uvs be uploaded and applied.
 * @param [properties.alpha=false] {boolean} When true, alpha be uploaded and applied.
 * @param [batchSize=15000] {number} Number of particles per batch.
 */
class ParticleContainer extends core.Container {
    constructor(maxSize, properties, batchSize)
    {
        super();

        batchSize = batchSize || 15000; //CONST.SPRITE_BATCH_SIZE; // 2000 is a nice balance between mobile / desktop
        maxSize = maxSize || 15000;

        // Making sure the batch size is valid
        // 65535 is max vertex index in the index buffer (see ParticleRenderer)
        // so max number of particles is 65536 / 4 = 16384
        let maxBatchSize = 16384;
        if (batchSize > maxBatchSize) {
            batchSize = maxBatchSize;
        }

        if (batchSize > maxSize) {
            batchSize = maxSize;
        }

        /**
         * Set properties to be dynamic (true) / static (false)
         *
         * @member {boolean[]}
         * @private
         */
        this._properties = [false, true, false, false, false];

        /**
         * @member {number}
         * @private
         */
        this._maxSize = maxSize;

        /**
         * @member {number}
         * @private
         */
        this._batchSize = batchSize;

        /**
         * @member {WebGLBuffer}
         * @private
         */
        this._glBuffers = [];

        /**
         * @member {number}
         * @private
         */
        this._bufferToUpdate = 0;

        /**
         * @member {boolean}
         *
         */
        this.interactiveChildren = false;

        /**
         * The blend mode to be applied to the sprite. Apply a value of `PIXI.BLEND_MODES.NORMAL` to reset the blend mode.
         *
         * @member {number}
         * @default PIXI.BLEND_MODES.NORMAL
         * @see PIXI.BLEND_MODES
         */
        this.blendMode = core.BLEND_MODES.NORMAL;

        /**
         * Used for canvas renderering. If true then the elements will be positioned at the nearest pixel. This provides a nice speed boost.
         *
         * @member {boolean}
         * @default true;
         */
        this.roundPixels = true;

        this.baseTexture = null;

        this.setProperties(properties);
    }

    /**
     * Sets the private properties array to dynamic / static based on the passed properties object
     *
     * @param properties {object} The properties to be uploaded
     */
    setProperties(properties)
    {
        if ( properties ) {
            this._properties[0] = 'scale' in properties ? !!properties.scale : this._properties[0];
            this._properties[1] = 'position' in properties ? !!properties.position : this._properties[1];
            this._properties[2] = 'rotation' in properties ? !!properties.rotation : this._properties[2];
            this._properties[3] = 'uvs' in properties ? !!properties.uvs : this._properties[3];
            this._properties[4] = 'alpha' in properties ? !!properties.alpha : this._properties[4];
        }
    }

    /**
     * Updates the object transform for rendering
     *
     * @private
     */
    updateTransform()
    {

        // TODO don't need to!
        this.displayObjectUpdateTransform();
        //  PIXI.Container.prototype.updateTransform.call( this );
    }

    /**
     * Renders the container using the WebGL renderer
     *
     * @param renderer {PIXI.WebGLRenderer} The webgl renderer
     * @private
     */
    renderWebGL(renderer)
    {
        if (!this.visible || this.worldAlpha <= 0 || !this.children.length || !this.renderable)
        {
            return;
        }


        if(!this.baseTexture)
        {
            this.baseTexture = this.children[0]._texture.baseTexture;
            if(!this.baseTexture.hasLoaded)
            {
                this.baseTexture.once('update', function(){
                    this.onChildrenChange(0);
                }, this);
            }
        }


        renderer.setObjectRenderer( renderer.plugins.particle );
        renderer.plugins.particle.render( this );
    }

    /**
     * Set the flag that static data should be updated to true
     *
     * @private
     */
    onChildrenChange(smallestChildIndex)
    {
        let bufferIndex = Math.floor(smallestChildIndex / this._batchSize);
        if (bufferIndex < this._bufferToUpdate) {
            this._bufferToUpdate = bufferIndex;
        }
    }

    /**
     * Renders the object using the Canvas renderer
     *
     * @param renderer {PIXI.CanvasRenderer} The canvas renderer
     * @private
     */
    renderCanvas(renderer)
    {
        if (!this.visible || this.worldAlpha <= 0 || !this.children.length || !this.renderable)
        {
            return;
        }

        let context = renderer.context;
        let transform = this.worldTransform;
        let isRotated = true;

        let positionX = 0;
        let positionY = 0;

        let finalWidth = 0;
        let finalHeight = 0;

        let compositeOperation = renderer.blendModes[this.blendMode];
        if (compositeOperation !== context.globalCompositeOperation)
        {
            context.globalCompositeOperation = compositeOperation;
        }

        context.globalAlpha = this.worldAlpha;

        this.displayObjectUpdateTransform();

        for (let i = 0; i < this.children.length; ++i)
        {
            let child = this.children[i];

            if (!child.visible)
            {
                continue;
            }

            let frame = child.texture.frame;

            context.globalAlpha = this.worldAlpha * child.alpha;

            if (child.rotation % (Math.PI * 2) === 0)
            {
                // this is the fastest  way to optimise! - if rotation is 0 then we can avoid any kind of setTransform call
                if (isRotated)
                {
                    context.setTransform(
                        transform.a,
                        transform.b,
                        transform.c,
                        transform.d,
                        transform.tx * renderer.resolution,
                        transform.ty * renderer.resolution
                    );

                    isRotated = false;
                }

                positionX = ((child.anchor.x) * (-frame.width * child.scale.x) + child.position.x  + 0.5);
                positionY = ((child.anchor.y) * (-frame.height * child.scale.y) + child.position.y  + 0.5);

                finalWidth = frame.width * child.scale.x;
                finalHeight = frame.height * child.scale.y;

            }
            else
            {
                if (!isRotated)
                {
                    isRotated = true;
                }

                child.displayObjectUpdateTransform();

                let childTransform = child.worldTransform;

                if (renderer.roundPixels)
                {
                    context.setTransform(
                        childTransform.a,
                        childTransform.b,
                        childTransform.c,
                        childTransform.d,
                        (childTransform.tx * renderer.resolution) | 0,
                        (childTransform.ty * renderer.resolution) | 0
                    );
                }
                else
                {
                    context.setTransform(
                        childTransform.a,
                        childTransform.b,
                        childTransform.c,
                        childTransform.d,
                        childTransform.tx * renderer.resolution,
                        childTransform.ty * renderer.resolution
                    );
                }

                positionX = ((child.anchor.x) * (-frame.width) + 0.5);
                positionY = ((child.anchor.y) * (-frame.height) + 0.5);

                finalWidth = frame.width;
                finalHeight = frame.height;
            }

            let resolution = child.texture.baseTexture.resolution;

            context.drawImage(
                child.texture.baseTexture.source,
                frame.x * resolution,
                frame.y * resolution,
                frame.width * resolution,
                frame.height * resolution,
                positionX * resolution,
                positionY * resolution,
                finalWidth * resolution,
                finalHeight * resolution
            );
        }
    }

    /**
     * Destroys the container
     *
     */
    destroy() {
        super.destroy(arguments);

        if (this._buffers) {
            for (let i = 0; i < this._buffers.length; ++i) {
                this._buffers[i].destroy();
            }
        }

        this._properties = null;
        this._buffers = null;
    }

}

module.exports = ParticleContainer;
