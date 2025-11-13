const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ ERROR: GEMINI_API_KEY no está configurada en el archivo .env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 📍 LEER ARCHIVO GEOJSON
let geoJsonData = null;
const geoJsonPath = path.join(__dirname, 'data', 'puntos_muela.geojson');

console.log(`🔍 Buscando GeoJSON en: ${geoJsonPath}`);

try {
  if (!fs.existsSync(geoJsonPath)) {
    console.error('❌ Archivo no encontrado:', geoJsonPath);
    console.error('💡 Crea: server/data/puntos_muela.geojson');
  } else {
    const rawData = fs.readFileSync(geoJsonPath, 'utf8');
    geoJsonData = JSON.parse(rawData);
    console.log(`✅ GeoJSON cargado: ${geoJsonData.features?.length || 0} puntos\n`);
    
    if (geoJsonData.features) {
      console.log('📍 Lugares:');
      geoJsonData.features.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.properties.LUGAR}`);
      });
      console.log('');
    }
  }
} catch (error) {
  console.error('❌ Error:', error.message);
}

// 🖼️ FUNCIÓN PARA CONVERTIR IMAGEN A BASE64
function imageToBase64(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString('base64');
  } catch (error) {
    console.error(`Error leyendo imagen: ${imagePath}`, error.message);
    return null;
  }
}

// 🖼️ PREPARAR IMAGEN PARA GEMINI VISION
function prepareImageForGemini(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  let mimeType = 'image/jpeg';
  
  if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.webp') mimeType = 'image/webp';
  else if (ext === '.gif') mimeType = 'image/gif';
  
  const base64Data = imageToBase64(imagePath);
  
  if (!base64Data) return null;
  
  return {
    inlineData: {
      data: base64Data,
      mimeType: mimeType
    }
  };
}

// 🗺️ FORMATEAR GEOJSON PARA CHATBOT
function formatGeoJsonForChatbot(geoJson) {
  if (!geoJson || !geoJson.features) return '';
  
  let formatted = '\n\n=== 📍 BASE DE DATOS: PUNTOS LA MUELA DEL DIABLO ===\n\n';
  formatted += `TOTAL: ${geoJson.features.length} LUGARES\n\n`;
  
  geoJson.features.forEach((feature, index) => {
    const props = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    
    formatted += `${index + 1}. 🏔️ ${props.LUGAR}\n`;
    
    if (coords.length >= 2) {
      formatted += `   📍 GPS: Lat ${coords[1].toFixed(6)}°, Lng ${coords[0].toFixed(6)}°\n`;
    }
    
    if (props.Norte && props.Sur) {
      formatted += `   🧭 UTM: Norte ${props.Norte}, Sur ${props.Sur}\n`;
    }
    
    if (props.descripcion) {
      formatted += `   ℹ️ ${props.descripcion}\n`;
    }
    
    if (props.imagenUrl) {
      formatted += `   📸 Imagen disponible: SÍ (${props.imagenUrl})\n`;
    }
    
    formatted += '\n';
  });
  
  formatted += '⚠️ INSTRUCCIONES:\n';
  formatted += '- Si preguntan "qué lugares hay", lista TODOS los 12 lugares\n';
  formatted += '- Si preguntan por uno específico, da TODA su info + menciona que hay imagen\n';
  formatted += '- Menciona que pueden ver imágenes de cada lugar\n\n';
  
  return formatted;
}

const CHATBOT_PERSONALITY = `Eres "Chimuelito", asistente virtual experto de La Muela del Diablo, Bolivia.

PERSONALIDAD:
- Amigable, entusiasta, experto absoluto en La Muela
- Emojis: 🏔️, 🥾, 📸, ✨, 🌄, 📍, 🗺️, 🧭
- Humor boliviano cálido
- Conversacional como guía local

CAPACIDADES:
- Base de datos con 12 puntos de interés
- Cada punto: nombre, GPS/UTM, descripción, imagen
- Puedes mostrar imágenes de los lugares cuando los menciones

INFORMACIÓN GENERAL:
- Ubicación: 35 km SE de La Paz, Viacha
- Altitud: ~3,650 msnm
- Acceso: Transporte público, tour, vehículo
- Mejor época: Mayo-Octubre
- Duración: 2-4 horas
- Dificultad: Moderada

LUGARES DESTACADOS (ver base de datos):
- Cima Muela del Diablo (vista 360°)
- Cueva del Auki Kollo (leyenda)
- Cóndor/Sapo de Piedra
- La Grieta
- Laguna estacional
- Sitio de Ofrenda

ESTILO:
- Natural y conversacional
- Usa base de datos para lugares
- Menciona imágenes disponibles
- 3-6 párrafos máximo
- Cuando hables de un lugar, di que tiene imagen para verla`;

const conversationHistories = new Map();

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    geoJsonLoaded: !!geoJsonData,
    pointsCount: geoJsonData?.features?.length || 0,
    pointsList: geoJsonData?.features?.map(f => f.properties.LUGAR) || []
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default', useVision = false } = req.body;
    
    console.log(`📩 "${message}" (${sessionId}) ${useVision ? '🖼️ Vision' : ''}`);

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Mensaje vacío' });
    }

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: 800,
      }
    });

    if (!conversationHistories.has(sessionId)) {
      conversationHistories.set(sessionId, []);
    }

    const history = conversationHistories.get(sessionId);
    let fullPrompt = CHATBOT_PERSONALITY;
    
    if (geoJsonData) {
      fullPrompt += formatGeoJsonForChatbot(geoJsonData);
    } else {
      fullPrompt += '\n\n⚠️ Sin base de datos. Usa info general.\n\n';
    }
    
    if (history.length > 0) {
      fullPrompt += 'CONVERSACIÓN RECIENTE:\n';
      history.slice(-4).forEach(msg => {
        fullPrompt += `${msg.role}: ${msg.content}\n`;
      });
      fullPrompt += '\n';
    }

    fullPrompt += `Usuario: ${message}\n\nChimuelito:`;

    // 🖼️ PREPARAR CONTENIDO CON O SIN IMÁGENES
    let contentParts = [fullPrompt];
    let includedImages = [];

    // Si Vision está habilitado y hay GeoJSON
    if (useVision && geoJsonData) {
      const messageLower = message.toLowerCase();
      
      for (const feature of geoJsonData.features) {
        const lugar = feature.properties.LUGAR.toLowerCase();
        const imagenUrl = feature.properties.imagenUrl;
        
        // Si menciona este lugar y tiene imagen
        if (messageLower.includes(lugar.split(' ')[0]) && imagenUrl) {
          const imagePath = path.join(__dirname, '..', 'public', imagenUrl);
          
          if (fs.existsSync(imagePath)) {
            const imageData = prepareImageForGemini(imagePath);
            if (imageData) {
              console.log(`🖼️ Analizando imagen: ${feature.properties.LUGAR}`);
              contentParts.push(imageData);
              contentParts.push(`\n[Imagen de ${feature.properties.LUGAR}. Descríbela brevemente en tu respuesta.]`);
              includedImages.push({
                lugar: feature.properties.LUGAR,
                url: imagenUrl
              });
            }
          }
        }
      }
    }

    console.log('🤖 Consultando Gemini...');

    const result = await model.generateContent(contentParts);
    const response = await result.response;
    let botResponse = response.text();

    if (!botResponse || botResponse.trim() === '' || botResponse === '...') {
      botResponse = '¡Ups! Hubo un problema. ¿Puedes reformular? 😊';
    }

    // 📸 DETECTAR IMÁGENES MENCIONADAS (para enviar al frontend)
    const imagesInResponse = [];
    if (geoJsonData && !useVision) { // Solo si no usamos Vision
      geoJsonData.features.forEach(feature => {
        const lugar = feature.properties.LUGAR;
        const imagenUrl = feature.properties.imagenUrl;
        
        if (imagenUrl && botResponse.toLowerCase().includes(lugar.toLowerCase())) {
          imagesInResponse.push({
            lugar: lugar,
            url: imagenUrl,
            descripcion: feature.properties.descripcion,
            coordenadas: feature.geometry.coordinates
          });
        }
      });
    }

    history.push({ role: 'Usuario', content: message });
    history.push({ role: 'Chimuelito', content: botResponse });

    if (history.length > 16) {
      history.splice(0, history.length - 16);
    }

    console.log(`✅ Respuesta (${botResponse.length} chars) + ${imagesInResponse.length} imágenes`);

    res.json({ 
      response: botResponse,
      images: imagesInResponse.length > 0 ? imagesInResponse : undefined,
      analyzedImages: includedImages.length > 0 ? includedImages : undefined
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ 
      error: 'Error técnico 😅',
      details: error.message 
    });
  }
});

// 🗺️ ENDPOINT GEOJSON
app.get('/api/geojson', (req, res) => {
  if (!geoJsonData) {
    return res.status(404).json({ 
      error: 'GeoJSON no disponible',
      path: geoJsonPath
    });
  }
  res.json(geoJsonData);
});

// 🔄 RESET CONVERSACIÓN
app.post('/api/reset', (req, res) => {
  const { sessionId = 'default' } = req.body;
  conversationHistories.delete(sessionId);
  console.log(`🔄 Reset (${sessionId})`);
  res.json({ message: 'Reset OK' });
});

// 🎯 OBTENER LUGAR ESPECÍFICO
app.get('/api/lugar/:nombre', (req, res) => {
  if (!geoJsonData) {
    return res.status(404).json({ error: 'Sin datos' });
  }
  
  const nombreBuscado = req.params.nombre.toLowerCase();
  const lugar = geoJsonData.features.find(f => 
    f.properties.LUGAR.toLowerCase().includes(nombreBuscado)
  );
  
  if (!lugar) {
    return res.status(404).json({ 
      error: 'Lugar no encontrado',
      disponibles: geoJsonData.features.map(f => f.properties.LUGAR)
    });
  }
  
  res.json(lugar);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🚀 Chimuelito en http://localhost:${PORT}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`✅ Gemini API: Configurada`);
  console.log(`🗺️ GeoJSON: ${geoJsonData ? '✅ ' + geoJsonData.features.length + ' puntos' : '❌ No cargado'}`);
  console.log(`🖼️ Gemini Vision: Disponible`);
  console.log(`\n🌐 Endpoints:`);
  console.log(`   GET  http://localhost:${PORT}/api/health`);
  console.log(`   GET  http://localhost:${PORT}/api/geojson`);
  console.log(`   GET  http://localhost:${PORT}/api/lugar/:nombre`);
  console.log(`   POST http://localhost:${PORT}/api/chat`);
  console.log(`   POST http://localhost:${PORT}/api/reset`);
  console.log(`${'='.repeat(70)}\n`);
});
