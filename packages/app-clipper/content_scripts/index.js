/* eslint-disable no-console */

(function() {

	if (window.jopext_hasRun) return;
	window.jopext_hasRun = true;

	console.info('jopext: Loading content script');

	let browser_ = null;
	if (typeof browser !== 'undefined') {
		// eslint-disable-next-line no-undef
		browser_ = browser;
		// eslint-disable-next-line no-undef
		browserSupportsPromises_ = true;
	} else if (typeof chrome !== 'undefined') {
		// eslint-disable-next-line no-undef
		browser_ = chrome;
		// eslint-disable-next-line no-undef
		browserSupportsPromises_ = false;
	}

	function escapeHtml(s) {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function pageTitle() {
		const titleElements = document.getElementsByTagName('title');
		if (titleElements.length) return titleElements[0].text.trim();
		return document.title.trim();
	}

	function getAnchorNames(element) {
		const output = [];
		// Anchor names are normally in A tags but can be in SPAN too
		// https://github.com/dpjl/joplin-turndown/commit/45f4ee6bf15b8804bdc2aa1d7ecb2f8cb594b8e5#diff-172b8b2bc3ba160589d3a7eeb4913687R232
		for (const tagName of ['a', 'span']) {
			const anchors = element.getElementsByTagName(tagName);
			for (let i = 0; i < anchors.length; i++) {
				const anchor = anchors[i];
				if (anchor.id) {
					output.push(anchor.id);
				} else if (anchor.name) {
					output.push(anchor.name);
				}
			}
		}
		return output;
	}

	// Cleans up element by removing all its invisible children (which we don't want to render as Markdown)
	// And hard-code the image dimensions so that the information can be used by the clipper server to
	// display them at the right sizes in the notes.
	function cleanUpElement(convertToMarkup, element, imageSizes, imageIndexes) {
		const childNodes = element.childNodes;
		const hiddenNodes = [];

		for (let i = 0; i < childNodes.length; i++) {
			const node = childNodes[i];
			const nodeName = node.nodeName.toLowerCase();

			const isHidden = node && node.classList && node.classList.contains('joplin-clipper-hidden');

			if (isHidden) {
				hiddenNodes.push(node);
			} else {

				// If the data-joplin-clipper-value has been set earlier, create a new DIV element
				// to replace the input or text area, so that it can be exported.
				if (node.getAttribute && node.getAttribute('data-joplin-clipper-value')) {
					const div = document.createElement('div');
					div.innerText = node.getAttribute('data-joplin-clipper-value');
					node.parentNode.insertBefore(div, node.nextSibling);
					element.removeChild(node);
				}

				if (nodeName === 'img') {
					// eslint-disable-next-line no-undef
					const src = absoluteUrl(imageSrc(node));
					node.setAttribute('src', src);
					if (!(src in imageIndexes)) imageIndexes[src] = 0;

					if (!imageSizes[src]) {
						// This seems to concern dynamic images that don't really such as Gravatar, etc.
						console.warn('Found an image for which the size had not been fetched:', src);
					} else {
						const imageSize = imageSizes[src][imageIndexes[src]];
						imageIndexes[src]++;
						if (imageSize && convertToMarkup === 'markdown') {
							node.width = imageSize.width;
							node.height = imageSize.height;
						}
					}
				}

				if (nodeName === 'svg') {
					// eslint-disable-next-line no-undef
					const className = getJoplinClipperSvgClassName(node);
					if (!(className in imageIndexes)) imageIndexes[className] = 0;

					if (!imageSizes[className]) {
						// This seems to concern dynamic images that don't really such as Gravatar, etc.
						console.warn('Found an SVG for which the size had not been fetched:', className);
					} else {
						const imageSize = imageSizes[className][imageIndexes[className]];
						imageIndexes[className]++;
						if (imageSize) {
							node.style.width = `${imageSize.width}px`;
							node.style.height = `${imageSize.height}px`;
						}
					}
				}

				if (nodeName === 'embed') {
					// eslint-disable-next-line no-undef
					const src = absoluteUrl(node.src);
					node.setAttribute('src', src);
				}

				if (nodeName === 'object') {
					// eslint-disable-next-line no-undef
					const data = absoluteUrl(node.data);
					node.setAttribute('data', data);
				}

				cleanUpElement(convertToMarkup, node, imageSizes, imageIndexes);
			}
		}

		for (const hiddenNode of hiddenNodes) {
			if (!hiddenNode.parentNode) continue;
			hiddenNode.parentNode.removeChild(hiddenNode);
		}
	}

	// When we clone the document before cleaning it, we lose some of the information that might have been set via CSS or
	// JavaScript, in particular whether an element was hidden or not. This function pre-process the document by
	// adding a "joplin-clipper-hidden" class to all currently hidden elements in the current document.
	// This class is then used in cleanUpElement() on the cloned document to find an element should be visible or not.
	function preProcessDocument(element) {
		const childNodes = element.childNodes;

		for (let i = childNodes.length - 1; i >= 0; i--) {
			const node = childNodes[i];
			const nodeName = node.nodeName.toLowerCase();
			const nodeParent = node.parentNode;
			const nodeParentName = nodeParent ? nodeParent.nodeName.toLowerCase() : '';
			const computedStyle = node.nodeType === 1 ? window.getComputedStyle(node) : {};

			let isVisible = node.nodeType === 1 ? computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' : true;
			if (isVisible && ['script', 'noscript', 'style', 'select', 'option', 'button'].indexOf(nodeName) >= 0) isVisible = false;

			// If it's a text input or a textarea and it has a value, save
			// that value to data-joplin-clipper-value. This is then used
			// when cleaning up the document to export the value.
			if (['input', 'textarea'].indexOf(nodeName) >= 0) {
				isVisible = !!node.value;
				if (nodeName === 'input' && node.getAttribute('type') !== 'text') isVisible = false;
				if (isVisible) node.setAttribute('data-joplin-clipper-value', node.value);
			}

			if (nodeName === 'script') {
				const a = node.getAttribute('type');
				if (a && a.toLowerCase().indexOf('math/tex') >= 0) isVisible = true;
			}

			if (nodeName === 'source' && nodeParentName === 'picture') {
				isVisible = false;
			}

			if (node.nodeType === 8) { // Comments are just removed since we can't add a class
				node.parentNode.removeChild(node);
			} else if (!isVisible) {
				node.classList.add('joplin-clipper-hidden');
			} else {
				preProcessDocument(node);
			}
		}
	}

	// This sets the PRE elements computed style to the style attribute, so that
	// the info can be exported and later processed by the htmlToMd converter
	// to detect code blocks.
	function hardcodePreStyles(doc) {
		const preElements = doc.getElementsByTagName('pre');

		for (const preElement of preElements) {
			const fontFamily = getComputedStyle(preElement).getPropertyValue('font-family');
			const fontFamilyArray = fontFamily.split(',').map(f => f.toLowerCase().trim());
			if (fontFamilyArray.indexOf('monospace') >= 0) {
				preElement.style.fontFamily = fontFamily;
			}
		}
	}

	function addSvgClass(doc) {
		const svgs = doc.getElementsByTagName('svg');
		let svgId = 0;

		for (const svg of svgs) {
			// eslint-disable-next-line no-undef
			if (!getJoplinClipperSvgClassName(svg)) {
				svg.classList.add(`joplin-clipper-svg-${svgId}`);
				svgId++;
			}
		}
	}

	function documentForReadability() {
		// Readability directly change the passed document so clone it so as
		// to preserve the original web page.
		return document.cloneNode(true);
	}

	function readabilityProcess() {

		if (isPagePdf()) throw new Error('Could not parse PDF document with Readability');

		// eslint-disable-next-line no-undef
		const readability = new Readability(documentForReadability());
		const article = readability.parse();

		if (!article) throw new Error('Could not parse HTML document with Readability');

		return {
			title: article.title,
			body: article.content,
		};
	}

	function isPagePdf() {
		return document.contentType === 'application/pdf';
	}

	function embedPageUrl() {
		return `<embed src="${escapeHtml(window.location.href)}" type="${escapeHtml(document.contentType)}" />`;
	}

	async function prepareCommandResponse(command) {
		console.info(`Got command: ${command.name}`);
		const shouldSendToJoplin = !!command.shouldSendToJoplin;

		const convertToMarkup = command.preProcessFor ? command.preProcessFor : 'markdown';

		const clippedContentResponse = (title, html, imageSizes, anchorNames, stylesheets) => {
			return {
				name: shouldSendToJoplin ? 'sendContentToJoplin' : 'clippedContent',
				title: title,
				html: html,
				// eslint-disable-next-line no-undef
				base_url: baseUrl(),
				// eslint-disable-next-line no-undef
				url: pageLocationOrigin() + location.pathname + location.search,
				parent_id: command.parent_id,
				tags: command.tags || '',
				image_sizes: imageSizes,
				anchor_names: anchorNames,
				source_command: { ...command },
				convert_to: convertToMarkup,
				stylesheets: stylesheets,
			};
		};

		if (command.name === 'simplifiedPageHtml') {

			let article = null;
			try {
				article = readabilityProcess();
			} catch (error) {
				console.warn(error);
				console.warn('Sending full page HTML instead');
				const newCommand = { ...command, name: 'completePageHtml' };
				const response = await prepareCommandResponse(newCommand);
				response.warning = 'Could not retrieve simplified version of page - full page has been saved instead.';
				return response;
			}
			// eslint-disable-next-line no-undef
			return clippedContentResponse(article.title, article.body, getImageSizes(document), getAnchorNames(document));

		} else if (command.name === 'isProbablyReaderable') {

			// eslint-disable-next-line no-undef
			const ok = isProbablyReaderable(documentForReadability());
			return { name: 'isProbablyReaderable', value: ok };

		} else if (command.name === 'completePageHtml') {

			if (isPagePdf()) {
				// eslint-disable-next-line no-undef
				return clippedContentResponse(pageTitle(), embedPageUrl(), getImageSizes(document), getAnchorNames(document));
			}

			hardcodePreStyles(document);
			addSvgClass(document);
			preProcessDocument(document);
			// Because cleanUpElement is going to modify the DOM and remove elements we don't want to work
			// directly on the document, so we make a copy of it first.
			const cleanDocument = document.body.cloneNode(true);
			// eslint-disable-next-line no-undef
			const imageSizes = getImageSizes(document, true);
			const imageIndexes = {};
			cleanUpElement(convertToMarkup, cleanDocument, imageSizes, imageIndexes);

			// eslint-disable-next-line no-undef
			const stylesheets = convertToMarkup === 'html' ? getStyleSheets(document) : null;

			// The <BODY> tag may have a style in the CSS stylesheets. This
			// style can be overriden by setting the `style` attribute on the
			// BODY tag. Since we don't keep the body tag, it means we may be
			// missing some styling, which may break the page.
			//
			// For example, on this page:
			// https://devblogs.microsoft.com/oldnewthing/20180529-00/?p=98855
			// The BODY tag has visibility set to hidden in the stylesheet, and
			// made visible by setting the style attribute. Because of that,
			// previously that imported note would show blank content, while now
			// it will be visible.
			//
			// Fixes https://github.com/dpjl/joplin/issues/7925
			if (document.body.getAttribute('style')) {
				stylesheets.push({
					type: 'text',
					value: `body { ${document.body.getAttribute('style')} }`,
				});
			}

			return clippedContentResponse(pageTitle(), cleanDocument.innerHTML, imageSizes, getAnchorNames(document), stylesheets);

		} else if (command.name === 'selectedHtml') {

			hardcodePreStyles(document);
			addSvgClass(document);
			preProcessDocument(document);

			const container = document.createElement('div');
			const rangeCount = window.getSelection().rangeCount;

			// Even when the user makes only one selection, Firefox might report multiple selections
			// so we need to process them all.
			// Fixes https://github.com/dpjl/joplin/issues/2294
			for (let i = 0; i < rangeCount; i++) {
				const range = window.getSelection().getRangeAt(i);
				container.appendChild(range.cloneContents());
			}

			// eslint-disable-next-line no-undef
			const imageSizes = getImageSizes(document, true);
			const imageIndexes = {};
			cleanUpElement(convertToMarkup, container, imageSizes, imageIndexes);
			// eslint-disable-next-line no-undef
			return clippedContentResponse(pageTitle(), container.innerHTML, getImageSizes(document), getAnchorNames(document));

		} else if (command.name === 'screenshot') {

			const overlay = document.createElement('div');
			overlay.style.opacity = '0.6';
			overlay.style.background = 'black';
			overlay.style.width = '100%';
			overlay.style.height = '100%';
			overlay.style.zIndex = 99999999;
			overlay.style.top = 0;
			overlay.style.left = 0;
			overlay.style.position = 'fixed';

			document.body.appendChild(overlay);

			const messageComp = document.createElement('div');

			const messageCompWidth = 300;
			messageComp.style.position = 'fixed';
			messageComp.style.opacity = '0.95';
			messageComp.style.fontSize = '14px';
			messageComp.style.width = `${messageCompWidth}px`;
			messageComp.style.maxWidth = `${messageCompWidth}px`;
			messageComp.style.border = '1px solid black';
			messageComp.style.background = 'white';
			messageComp.style.color = 'black';
			messageComp.style.top = '10px';
			messageComp.style.textAlign = 'center';
			messageComp.style.padding = '10px';
			messageComp.style.left = `${Math.round(document.body.clientWidth / 2 - messageCompWidth / 2)}px`;
			messageComp.style.zIndex = overlay.style.zIndex + 1;

			messageComp.textContent = 'Drag and release to capture a screenshot';

			document.body.appendChild(messageComp);

			const selection = document.createElement('div');
			selection.style.opacity = '0.4';
			selection.style.border = '1px solid red';
			selection.style.background = 'white';
			selection.style.border = '2px solid black';
			selection.style.zIndex = overlay.style.zIndex - 1;
			selection.style.top = 0;
			selection.style.left = 0;
			selection.style.position = 'fixed';

			document.body.appendChild(selection);

			let isDragging = false;
			let draggingStartPos = null;
			let selectionArea = {};

			const updateSelection = function() {
				selection.style.left = `${selectionArea.x}px`;
				selection.style.top = `${selectionArea.y}px`;
				selection.style.width = `${selectionArea.width}px`;
				selection.style.height = `${selectionArea.height}px`;
			};

			const setSelectionSizeFromMouse = function(event) {
				selectionArea.width = Math.max(1, event.clientX - draggingStartPos.x);
				selectionArea.height = Math.max(1, event.clientY - draggingStartPos.y);
				updateSelection();
			};

			const selection_mouseDown = function(event) {
				selectionArea = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
				draggingStartPos = { x: event.clientX, y: event.clientY };
				isDragging = true;
				updateSelection();
			};

			const selection_mouseMove = function(event) {
				if (!isDragging) return;
				setSelectionSizeFromMouse(event);
			};

			const selection_mouseUp = function(event) {
				setSelectionSizeFromMouse(event);

				isDragging = false;

				overlay.removeEventListener('mousedown', selection_mouseDown);
				overlay.removeEventListener('mousemove', selection_mouseMove);
				overlay.removeEventListener('mouseup', selection_mouseUp);

				document.body.removeChild(overlay);
				document.body.removeChild(selection);
				document.body.removeChild(messageComp);

				console.info('jopext: selectionArea:', selectionArea);

				if (!selectionArea || !selectionArea.width || !selectionArea.height) return;

				// Need to wait a bit before taking the screenshot to make sure
				// the overlays have been removed and don't appear in the
				// screenshot. 10ms is not enough.
				setTimeout(() => {
					const content = {
						title: pageTitle(),
						crop_rect: selectionArea,
						// eslint-disable-next-line no-undef
						url: pageLocationOrigin() + location.pathname + location.search,
						parent_id: command.parent_id,
						tags: command.tags,
						windowInnerWidth: window.innerWidth,
						windowInnerHeight: window.innerHeight,
					};

					browser_.runtime.sendMessage({
						name: 'screenshotArea',
						content: content,
						api_base_url: command.api_base_url,
						token: command.token,
					});
				}, 100);
			};

			overlay.addEventListener('mousedown', selection_mouseDown);
			overlay.addEventListener('mousemove', selection_mouseMove);
			overlay.addEventListener('mouseup', selection_mouseUp);

			return {};

		} else if (command.name === 'pageUrl') {

			// eslint-disable-next-line no-undef
			const url = pageLocationOrigin() + location.pathname + location.search;
			// eslint-disable-next-line no-undef
			return clippedContentResponse(pageTitle(), url, getImageSizes(document), getAnchorNames(document));

		} else {
			throw new Error(`Unknown command: ${JSON.stringify(command)}`);
		}
	}

	async function execCommand(command) {
		const response = await prepareCommandResponse(command);
		browser_.runtime.sendMessage(response);
	}

	browser_.runtime.onMessage.addListener((command) => {
		console.info('jopext: Got command:', command);

		execCommand(command);
	});

})();
